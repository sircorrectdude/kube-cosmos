import { useMemo, useState } from 'react';
import type { KEvent } from './types';

const KEY = 'kube-cosmos.events';
type Filter = 'all' | 'warn';
interface Group { key: string; ev: KEvent; count: number; t: number }

const load = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } };
const save = (v: object) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* egal */ } };

function ago(t: number) {
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/**
 * Live-Events: gleiche Meldungen (Typ, Grund, Objekt) werden gebündelt (×N, jüngste Zeit),
 * Filter Alle/Warnungen, einklappbar; Klick auf das Objekt wählt es in der Szene aus.
 */
export function Events({ events, onPick }: { events: KEvent[]; onPick: (e: KEvent) => void }) {
  const [st, setSt] = useState<{ open: boolean; filter: Filter }>(() => ({ open: true, filter: 'all', ...load() }));
  const [expanded, setExpanded] = useState<string | null>(null);
  const set = (p: Partial<typeof st>) => setSt(s => { const n = { ...s, ...p }; save(n); return n; });

  const groups = useMemo(() => {
    const m = new Map<string, Group>();
    for (const e of events) { // neueste zuerst
      const key = `${e.type}|${e.reason}|${e.namespace}|${e.object}`;
      const g = m.get(key);
      const t = Date.parse(e.time ?? '') || 0;
      if (g) { g.count++; g.t = Math.max(g.t, t); } else m.set(key, { key, ev: e, count: 1, t });
    }
    return [...m.values()];
  }, [events]);
  const warns = groups.filter(g => g.ev.type === 'Warning').length;
  const shown = st.filter === 'warn' ? groups.filter(g => g.ev.type === 'Warning') : groups;

  return (
    <section className={'evbox' + (st.open ? '' : ' closed')}>
      <header className="evhead">
        <button className="evtoggle" onClick={() => set({ open: !st.open })} title={st.open ? 'Einklappen' : 'Ausklappen'}>
          <span className="chev">{st.open ? '▾' : '▸'}</span> Live-Events
        </button>
        {warns > 0 && <span className="evcount warn" title="Warnungen">{warns}</span>}
        <span className="evcount" title="Meldungen (gebündelt)">{groups.length}</span>
        <span className="spacer" />
        {st.open && (
          <span className="seg">
            <button className={st.filter === 'all' ? 'on' : ''} onClick={() => set({ filter: 'all' })}>Alle</button>
            <button className={st.filter === 'warn' ? 'on' : ''} onClick={() => set({ filter: 'warn' })}>Warnungen</button>
          </span>
        )}
      </header>
      {st.open && (
        <ul className="evlist">
          {!shown.length && <li className="evempty">Keine {st.filter === 'warn' ? 'Warnungen' : 'Events'}</li>}
          {shown.map(({ key, ev, count, t }) => {
            const [kind, name] = (ev.object ?? '').split('/');
            const open = expanded === key;
            return (
              <li key={key} className={'ev' + (ev.type === 'Warning' ? ' warn' : '')}>
                <div className="evline">
                  <b className="evreason">{ev.reason}</b>
                  {count > 1 && <span className="evx">×{count}</span>}
                  <span className="spacer" />
                  <time>{ago(t)}</time>
                </div>
                <button className="evobj" onClick={() => onPick(ev)} title="In der Szene auswählen">
                  <span className="evkind">{kind}</span> {ev.namespace ? `${ev.namespace}/` : ''}{name}
                </button>
                {ev.message && (
                  <div className={'evmsg' + (open ? ' open' : '')} onClick={() => setExpanded(open ? null : key)} title={open ? '' : 'Ganze Meldung'}>
                    {ev.message}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
