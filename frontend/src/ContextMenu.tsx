import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GraphModel } from './graph';
import { actionsFor, needsCommands, type Action } from './actions';
import { colorOf } from './colors';

export interface MenuState { id: string; x: number; y: number }

/** Rechtsklick-Menü für ein Objekt der 3D-Ansicht. */
export function ContextMenu({ menu, model, commandsEnabled, run, onDetails, onFocus, onClose }: {
  menu: MenuState; model: GraphModel; commandsEnabled: boolean;
  run: (cmd: string, read: boolean, label: string) => void;
  onDetails: (id: string) => void; onFocus: (id: string) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [scaleTo, setScaleTo] = useState<number | null>(null);
  const res = model.node(menu.id)?.res;

  // im Fenster halten
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.min(menu.x, innerWidth - r.width - 8), y: Math.min(menu.y, innerHeight - r.height - 8) });
  }, [menu.x, menu.y]);

  // schließen bei Klick daneben / Esc
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key);
    return () => { removeEventListener('pointerdown', down, true); removeEventListener('keydown', key); };
  }, [onClose]);

  if (!res) return null;
  const actions = actionsFor(res).filter(a => commandsEnabled || !needsCommands(a));

  const exec = (a: Action) => {
    if (a.kind === 'local') {
      if (a.id === 'details') onDetails(menu.id);
      if (a.id === 'focus') { onDetails(menu.id); onFocus(menu.id); }
      if (a.id === 'copy') navigator.clipboard?.writeText(res.name).catch(() => {});
    } else if (a.kind === 'kubectl') run(a.cmd, !!a.read, `${a.label}: ${res.kind} ${res.name}`);
    else if (a.kind === 'scale') { setScaleTo(a.current); return; }
    onClose();
  };

  return (
    <div ref={ref} className="ctxmenu" style={{ left: pos.x, top: pos.y }} onContextMenu={e => e.preventDefault()}>
      <div className="ctxhead" style={{ color: colorOf(res) }}>
        {res.kind} <b>{res.name}</b>{res.namespace && <span> · {res.namespace}</span>}
      </div>
      {actions.map((a, i) => {
        if (a.kind === 'sep') return <hr key={i} />;
        if (a.kind === 'scale' && scaleTo !== null) return (
          <div key={i} className="ctxscale">
            <button onClick={() => setScaleTo(Math.max(0, scaleTo - 1))}>−</button>
            <input type="number" min={0} max={50} value={scaleTo} onChange={e => setScaleTo(Math.max(0, Math.min(50, Number(e.target.value))))} autoFocus />
            <button onClick={() => setScaleTo(Math.min(50, scaleTo + 1))}>+</button>
            <button className="ok" onClick={() => { run(`kubectl scale ${a.target} -n ${a.ns} --replicas=${scaleTo}`, false, `${res.name} auf ${scaleTo} skalieren`); onClose(); }}>
              auf {scaleTo} skalieren
            </button>
          </div>
        );
        const cls = 'ctxitem' + ('danger' in a && a.danger ? ' danger' : '') + ('read' in a && a.read ? ' read' : '');
        const hint = a.kind === 'scale' ? `aktuell ${a.current}` : a.kind === 'kubectl' ? (a.read ? 'sofort' : 'mit Bestätigung') : '';
        return (
          <button key={i} className={cls} onClick={() => exec(a)}>
            <span>{a.label}</span>{hint && <small>{hint}</small>}
          </button>
        );
      })}
      {!commandsEnabled && <div className="ctxnote">Aktionen im Modus readonly deaktiviert</div>}
    </div>
  );
}
