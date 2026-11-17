import { useEffect, useRef, useState } from 'react';
import type { GraphModel } from './graph';
import { DEFAULTS, setSettings, useSettings, type Settings } from './settings';

/** Zahnrad im HUD → Menü mit globalen Anzeige-Einstellungen. */
export function SettingsMenu({ model }: { model: GraphModel }) {
  const [open, setOpen] = useState(false);
  const s = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const click = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener('keydown', key);
    addEventListener('mousedown', click);
    return () => { removeEventListener('keydown', key); removeEventListener('mousedown', click); };
  }, [open]);

  const toggle = (k: keyof Settings, label: string, hint?: string) => (
    <label className="srow">
      <span>{label}{hint && <small>{hint}</small>}</span>
      <input type="checkbox" className="switch" checked={s[k] as boolean} onChange={e => setSettings({ [k]: e.target.checked })} />
    </label>
  );
  const slider = (k: keyof Settings, label: string, max: number, step: number) => (
    <label className="srow">
      <span>{label}<small>{(s[k] as number).toFixed(1)}</small></span>
      <input type="range" min={0} max={max} step={step} value={s[k] as number} onChange={e => setSettings({ [k]: Number(e.target.value) })} />
    </label>
  );

  return (
    <div className="settings" ref={ref}>
      <button className={'gear' + (open ? ' on' : '')} onClick={() => setOpen(o => !o)} title="Einstellungen" aria-expanded={open}>⚙</button>
      {open && (
        <div className="spanel" role="dialog" aria-label="Einstellungen">
          <div className="shead">Einstellungen</div>
          <div className="sgroup">Darstellung</div>
          <div className="srow">
            <span>Ansicht</span>
            <span className="seg">
              <button className={model.layout === 'ns' ? 'on' : ''} onClick={() => model.setLayout('ns')}>Namespaces</button>
              <button className={model.layout === 'node' ? 'on' : ''} onClick={() => model.setLayout('node')}>Nodes</button>
            </span>
          </div>
          {toggle('stars', 'Sternenhimmel', 'Hintergrund')}
          {toggle('labels', 'Namen anzeigen', 'Namespaces, Nodes, Satelliten')}
          {toggle('hulls', 'Hüllen statt Linien', 'Namespaces und Deployments als Blasen')}
          {toggle('autoRotate', 'Automatisch drehen')}
          {slider('bloom', 'Leuchten', 2.5, 0.1)}
          {slider('nodeLines', 'Kraftlinien zu Nodes', 3, 0.1)}
          <div className="sgroup">Animationen</div>
          {toggle('traffic', 'Traffic-Kometen')}
          {toggle('routing', 'Echte Route', 'über Ingress-Tor und Service')}
          {toggle('sparks', 'Event-Funken')}
          <div className="sfoot">
            <button onClick={() => setSettings(DEFAULTS)}>Zurücksetzen</button>
          </div>
        </div>
      )}
    </div>
  );
}
