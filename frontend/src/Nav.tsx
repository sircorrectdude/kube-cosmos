import type { GraphModel } from './graph';

/** Navigationsleiste oben: Namespace-Auswahl (Filter) + Übersicht (alles Sichtbare ins Bild). */
export function Nav({ model, onFilter, onOverview, onClean, replay, replayOn }: { model: GraphModel; onClean: () => void; replay?: () => void; replayOn?: boolean; onFilter: (ns: string | null) => void; onOverview: () => void }) {
  const names = [...model.nodes.values()].filter(n => n.res.kind === 'Namespace').map(n => n.res.name).sort();
  return (
    <div className="nav">
      <select className={model.nsFilter ? 'on' : ''} value={model.nsFilter ?? ''} title="Namespace anzeigen"
        onChange={e => onFilter(e.target.value || null)}>
        <option value="">Alle Namespaces</option>
        {names.map(n => <option key={n} value={n}>{n}</option>)}
      </select>
      <button onClick={onOverview} title="Übersicht (Taste O / Pos1)">⌂ Übersicht</button>
      {replay && <button className={replayOn ? 'on' : ''} onClick={replay} title="Vergangenheit abspielen">⏱ Replay</button>}
      <button onClick={onClean} title="Alle Panels ausblenden (Taste H)">⛶ Nur Szene</button>
    </div>
  );
}
