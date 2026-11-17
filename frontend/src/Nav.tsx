import type { GraphModel } from './graph';

/** Navigationsleiste oben: Namespace-Auswahl (Filter) + Übersicht (alles Sichtbare ins Bild). */
export function Nav({ model, onFilter, onOverview, onClean }: { model: GraphModel; onClean: () => void; onFilter: (ns: string | null) => void; onOverview: () => void }) {
  const names = [...model.nodes.values()].filter(n => n.res.kind === 'Namespace').map(n => n.res.name).sort();
  return (
    <div className="nav">
      <select className={model.nsFilter ? 'on' : ''} value={model.nsFilter ?? ''} title="Namespace anzeigen"
        onChange={e => onFilter(e.target.value || null)}>
        <option value="">Alle Namespaces</option>
        {names.map(n => <option key={n} value={n}>{n}</option>)}
      </select>
      <button onClick={onOverview} title="Übersicht (Taste O / Pos1)">⌂ Übersicht</button>
      <button onClick={onClean} title="Alle Panels ausblenden (Taste H)">⛶ Nur Szene</button>
    </div>
  );
}
