import { useEffect, useState } from 'react';
import { top, type GraphModel } from './graph';
import type { KEvent } from './types';
import { Events } from './Events';
import { colorOf, HOT, HPA_COLORS, MEM_ALERT, PROBE_COLOR } from './colors';
import { TRAFFIC_COLORS } from './Particles';

const pct = (v: number) => `${Math.round(v * 100)} %`;
const gib = (b: number) => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GiB` : `${Math.round(b / 1048576)} MiB`;
const ACCESS: Record<string, string> = { ReadWriteOnce: 'RWO (ein Node)', ReadOnlyMany: 'ROX (viele, lesend)', ReadWriteMany: 'RWX (viele)', ReadWriteOncePod: 'RWOP (ein Pod)' };

function Bar({ v, label }: { v: number; label: string }) {
  const c = v > 0.85 ? MEM_ALERT : v > 0.6 ? HOT : '#3cf0a0';
  return <span className="bar" title={`${label} ${pct(v)}`}><b style={{ width: `${Math.min(100, v * 100)}%`, background: c }} /></span>;
}

export function Panel({ model, selected, events, onPick }: { model: GraphModel; selected: string | null; events: KEvent[]; onPick: (e: KEvent) => void }) {
  const node = selected ? model.node(selected) : undefined;
  const sel = node?.res;
  const isSat = sel?.kind === 'External' || sel?.kind === 'Ingress';
  const [, tick] = useState(0);
  useEffect(() => { // Satelliten-Statistik live nachführen
    if (!isSat) return;
    const t = setInterval(() => tick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [isSat]);
  const st = sel?.kind === 'External' ? model.satStats.get(sel.uid) : undefined;
  const m = node?.metrics;
  return (
    <aside className="panel">
      {sel && (
        <section className="details">
          <h3 style={{ color: colorOf(sel) }}>{sel.kind === 'External' ? `Extern: ${sel.name} · ${sel.status}` : `${sel.kind}: ${sel.name}`}</h3>
          {sel.kind === 'External' ? <SatDetails st={st} /> : <table><tbody>
            {sel.kind === 'Deployment' && (() => {
              const h = model.hpaFor(sel);
              return h && <tr><td>HPA</td><td style={{ color: HPA_COLORS[h.status ?? 'Stable'] }}>
                {h.currentReplicas} → {h.desiredReplicas} (min {h.minReplicas}, max {h.maxReplicas}){h.status === 'AtMax' && ' – am Maximum'}
              </td></tr>;
            })()}
            {sel.kind === 'Ingress' && (
              <>
                {(sel.rules ?? []).map((r, i) => (
                  <tr key={i}><td>{i === 0 ? 'Regeln' : ''}</td><td><span className="mono">{r.host ?? '*'}{r.path}</span> → {r.service}:{r.port}</td></tr>
                ))}
                {sel.ingressClass && <tr><td>Klasse</td><td>{sel.ingressClass}</td></tr>}
                <tr><td>Extern</td><td>{(() => {
                  const sats = model.satellitesOf(sel.uid);
                  if (!sats.length) return <span style={{ opacity: .5 }}>gerade kein externer Traffic</span>;
                  return sats.map(s => {
                    const st = model.satStats.get(s.id);
                    const rate = st ? st.rate * Math.exp(-(performance.now() - st.rateAt) / 5000) / 5 : 0;
                    return <div key={s.id}>{s.res.status}: {rate.toFixed(1)} req/s{st?.errors ? `, ${st.errors} × 5xx` : ''}</div>;
                  });
                })()}</td></tr>
              </>
            )}
            {sel.kind === 'PVC' && (() => {
              const v = model.volumeMetrics[sel.uid];
              const users = (model.rel.pvcPods.get(sel.uid) ?? []).map(id => model.nodes.get(id)?.res.name).filter(Boolean);
              return (
                <>
                  <tr><td>Größe</td><td>{sel.capacity ?? '–'}</td></tr>
                  {v && <tr><td>Belegt</td><td>{gib(v.used)} von {gib(v.capacity)} ({pct(v.used / (v.capacity || 1))}) <Bar v={v.used / (v.capacity || 1)} label="Belegt" /></td></tr>}
                  <tr><td>Klasse</td><td>{sel.storageClass ?? '–'}</td></tr>
                  <tr><td>Zugriff</td><td>{(sel.accessModes ?? []).map(m => ACCESS[m] ?? m).join(', ') || '–'}</td></tr>
                  {sel.volumeName && <tr><td>Volume</td><td className="mono">{sel.volumeName}</td></tr>}
                  <tr><td>Pods</td><td>{users.length ? users.map(u => <div key={u}>{u}</div>) : <span style={{ opacity: .5 }}>von keinem Pod genutzt</span>}</td></tr>
                </>
              );
            })()}
            {sel.kind === 'Pod' && sel.pvcs && <tr><td>Volumes</td><td>{sel.pvcs.join(', ')}</td></tr>}
            {sel.kind === 'Node' && (
              <tr><td>Pods</td><td>{[...model.nodes.values()].filter(n => n.res.kind === 'Pod' && n.res.nodeName === sel.name).length}</td></tr>
            )}
            {m && (
              <>
                <tr><td>CPU</td><td>{Math.round(m.cpu * 1000)}m{m.cpuRel !== undefined && ` (${pct(m.cpuRel)} vom Limit/Request)`}</td></tr>
                <tr><td>RAM</td><td style={{ color: (m.memRel ?? 0) > 0.85 ? MEM_ALERT : undefined }}>
                  {(m.mem / 1048576).toFixed(1)} MiB{m.memRel !== undefined && ` (${pct(m.memRel)} vom Limit)`}
                </td></tr>
              </>
            )}
            {sel.probes && (
              <tr><td>probes</td><td>
                {Object.entries(sel.probes).map(([p, s]) => (
                  <span key={p} className="probe" style={{ borderColor: PROBE_COLOR[s], color: PROBE_COLOR[s] }}>
                    {p} {s === 'ok' ? '✓' : s === 'fail' ? '✗' : '…'}
                  </span>
                ))}
              </td></tr>
            )}
            {Object.entries(sel).filter(([k]) => !['uid', 'kind', 'name', 'probes', 'rules', 'ingressClass', 'pvcs', 'storageClass', 'capacity', 'accessModes', 'volumeName'].includes(k)).map(([k, v]) => (
              <tr key={k}><td>{k}</td><td>{typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a}=${b}`).join(', ') : String(v)}</td></tr>
            ))}
          </tbody></table>}
        </section>
      )}
      <Events events={events} onPick={onPick} />
    </aside>
  );
}

function SatDetails({ st }: { st?: import('./graph').SatStats }) {
  if (!st) return <p className="msg">noch keine Daten</p>;
  const rate = st.rate * Math.exp(-(performance.now() - st.rateAt) / 5000) / 5;
  return (
    <table><tbody>
      <tr><td>Rate</td><td>{rate.toFixed(1)} req/s</td></tr>
      <tr><td>Requests</td><td>{st.requests} seit {new Date(st.since).toLocaleTimeString()}</td></tr>
      <tr><td>Fehler 5xx</td><td style={{ color: st.errors ? TRAFFIC_COLORS.error : undefined }}>
        {st.errors} ({pct(st.requests ? st.errors / st.requests : 0)})</td></tr>
      <tr><td>Top-Clients</td><td>{top(st.clients).map(([k, v]) => <div key={k}>{k} <span className="obj">×{v}</span></div>)}</td></tr>
      <tr><td>Top-Pfade</td><td>{top(st.paths).map(([k, v]) => <div key={k}>{k} <span className="obj">×{v}</span></div>)}</td></tr>
    </tbody></table>
  );
}
