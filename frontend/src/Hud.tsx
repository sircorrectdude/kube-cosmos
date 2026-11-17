import { useState, type ReactNode } from 'react';
import type { GraphModel } from './graph';
import type { ServiceStatus } from './types';
import { SettingsMenu } from './SettingsMenu';
import { HOT, HPA_COLORS, INGRESS, LEGEND, MEM_ALERT, PVC, SUN } from './colors';
import { TRAFFIC_COLORS } from './Particles';

const KEY = 'kube-cosmos.hud';
type Sections = Record<string, boolean>; // Abschnitt → eingeklappt
const load = (): Sections => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } };

const STATE: Record<string, { c: string; t: string }> = {
  ok: { c: '#3cf0a0', t: 'verbunden' }, warn: { c: '#ffc94a', t: 'eingeschränkt' }, error: { c: '#ff3b5c', t: 'Fehler' },
  off: { c: '#5a6190', t: 'aus' }, unknown: { c: '#8f9cff', t: 'unbekannt' },
};

// Bekannte Quellen in fester Reihenfolge, neue hinten anhängen
const ORDER = ['k8s', 'prometheus', 'traffic', 'llm'];
const rank = (id: string) => { const i = ORDER.indexOf(id); return i < 0 ? 99 : i; };

/** Linkes Status-Panel: Verbindungen · Cluster · Auslastung · Legende – gruppiert und einklappbar. */
export function Hud({ model, mode, connected, status }: { model: GraphModel; mode: string; connected: boolean; status: ServiceStatus[] }) {
  const [closed, setClosed] = useState<Sections>(() => ({ legend: true, ...load() }));
  const toggle = (k: string) => setClosed(s => { const n = { ...s, [k]: !s[k] }; try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* egal */ } return n; });
  const count = (k: string) => { let n = 0; for (const x of model.nodes.values()) if (x.res.kind === k) n++; return n; };

  // Backend-Verbindung (WebSocket) zuerst, dann alles, was das Backend meldet; ohne Backend ist der Rest unbekannt
  const rows: ServiceStatus[] = [
    { id: 'ws', label: 'Backend', state: connected ? 'ok' : 'error', detail: connected ? 'WebSocket' : 'getrennt – verbinde neu …', since: 0 },
    ...[...status].sort((a, b) => rank(a.id) - rank(b.id)).map(s => (connected ? s : { ...s, state: 'unknown' as const })),
  ];
  const worst = rows.some(r => r.state === 'error') ? 'error' : rows.some(r => r.state === 'warn') ? 'warn' : 'ok';
  const nodes = Object.entries(model.nodeMetrics).sort();

  return (
    <div className="hud">
      <div className="titlerow"><span className="title">kube-cosmos</span><SettingsMenu model={model} /></div>
      <div className="hudcard">
        <Section id="status" title="Verbindungen" closed={closed} toggle={toggle}
          badge={<i className="sdot" style={{ background: STATE[worst].c, boxShadow: `0 0 6px ${STATE[worst].c}` }} title={STATE[worst].t} />}>
          <ul className="srvlist">
            {rows.map(r => (
              <li key={r.id} title={`${r.label}: ${STATE[r.state].t}${r.detail ? ' – ' + r.detail : ''}`}>
                <i className={'sdot' + (r.state === 'unknown' ? ' pulse' : '')} style={{ background: STATE[r.state].c, boxShadow: r.state === 'off' ? 'none' : `0 0 6px ${STATE[r.state].c}` }} />
                <span className="srvname">{r.label}</span>
                <span className={'srvstate ' + r.state}>{STATE[r.state].t}</span>
                {r.detail && <span className="srvdetail">{r.detail}</span>}
              </li>
            ))}
          </ul>
        </Section>

        <Section id="cluster" title="Cluster" closed={closed} toggle={toggle}>
          <div className="chips">
            <span className={'badge mode-' + mode}>Modus: {mode}</span>
            {model.layout === 'node' && <span className="badge">Ansicht: Nodes</span>}
            {model.nsFilter && (
              <span className="badge filter">nur {model.nsFilter}
                <button onClick={() => model.setNsFilter(null)} title="Filter entfernen">×</button>
              </span>
            )}
          </div>
          <div className="stats">
            {([['Nodes', model.k8sNodes.size], ['Namespaces', count('Namespace')], ['Deployments', count('Deployment')],
              ['Services', count('Service')], ['Pods', count('Pod')], ['Ingresses', count('Ingress')], ['PVCs', count('PVC')]] as const)
              .map(([l, v]) => <div key={l} className="stat"><b>{v}</b><span>{l}</span></div>)}
          </div>
        </Section>

        {nodes.length > 0 && (
          <Section id="load" title="Auslastung" closed={closed} toggle={toggle}>
            <table className="loadtab"><tbody>
              <tr><th /><th>CPU</th><th>RAM</th></tr>
              {nodes.map(([n, m]) => (
                <tr key={n}><td className="mono2">{n.replace(/^desktop-/, '')}</td><td><Bar v={m.cpu} /></td><td><Bar v={m.mem} /></td></tr>
              ))}
            </tbody></table>
          </Section>
        )}

        <Section id="legend" title="Legende" closed={closed} toggle={toggle}>
          <Legend title="Status" items={LEGEND} />
          <Legend title="Objekte" items={[['Node', SUN], ['Ingress', INGRESS], ['PVC', PVC], ['HPA-Ring', HPA_COLORS.Stable]]} />
          <Legend title="Traffic" items={[['Request', TRAFFIC_COLORS.request], ['Response OK', TRAFFIC_COLORS.response], ['Fehler 5xx', TRAFFIC_COLORS.error], ['Dropped', TRAFFIC_COLORS.dropped]]} />
          {model.metricsSource && <Legend title="Metriken" items={[['CPU-Last', HOT], ['RAM > 85 % Limit', MEM_ALERT]]} />}
        </Section>
      </div>
    </div>
  );
}

function Section({ id, title, closed, toggle, badge, children }: { id: string; title: string; closed: Sections; toggle: (k: string) => void; badge?: ReactNode; children: ReactNode }) {
  const c = !!closed[id];
  return (
    <section className={'hsec' + (c ? ' closed' : '')}>
      <button className="hsechead" onClick={() => toggle(id)}>
        <span className="chev">{c ? '▸' : '▾'}</span>{title}{badge && <span className="hbadge">{badge}</span>}
      </button>
      {!c && <div className="hsecbody">{children}</div>}
    </section>
  );
}

function Legend({ title, items }: { title: string; items: readonly (readonly [string, string])[] }) {
  return (
    <div className="lgrp">
      <span className="lgtitle">{title}</span>
      <div className="legend">{items.map(([l, c]) => <span key={l}><i style={{ background: c, boxShadow: `0 0 6px ${c}` }} />{l}</span>)}</div>
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)} %`;
function Bar({ v }: { v: number }) {
  const c = v > 0.85 ? MEM_ALERT : v > 0.6 ? HOT : '#3cf0a0';
  return <span className="lbar" title={pct(v)}><span className="bar"><b style={{ width: `${Math.min(100, v * 100)}%`, background: c }} /></span><small>{pct(v)}</small></span>;
}
