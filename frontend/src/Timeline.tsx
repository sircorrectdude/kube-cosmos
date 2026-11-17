import { useEffect, useRef, useState } from 'react';
import type { ReplayState } from './useCluster';

const SPEEDS = [1, 4, 16, 60];
const fmt = (ts: number, date = false) => new Date(ts).toLocaleString('de-DE',
  date ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Zeitleiste für das Replay: Springen, Abspielen, Tempo, Warn-Markierungen, zurück zu Live. */
export function Timeline({ r, range, seek, play, pause, live, onClose }: {
  r: ReplayState; range: () => void; seek: (ts: number, play: boolean, speed?: number) => void;
  play: (speed: number) => void; pause: () => void; live: () => void; onClose: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [drag, setDrag] = useState<number | null>(null);
  const started = useRef(false);

  // Zeitraum + Markierungen laden; beim Öffnen 10 Minuten zurück (pausiert)
  useEffect(() => { range(); const t = setInterval(range, 30_000); return () => clearInterval(t); }, [range]);
  useEffect(() => {
    if (started.current || !r.from) return;
    started.current = true;
    seek(Math.max(r.from, Date.now() - 10 * 60_000), false);
  }, [r.from, seek]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);

  const clock = r.playing ? r.ts + (now - r.wall) * r.speed : r.ts;
  const from = r.from || now - 60_000, to = Math.max(now, from + 1000);
  const value = drag ?? Math.min(Math.max(clock, from), to);
  const pct = (ts: number) => `${((ts - from) / (to - from)) * 100}%`;
  const commit = () => { if (drag != null) { seek(drag, r.playing, r.speed); setDrag(null); } };

  return (
    <div className="timeline">
      <div className="tlrow">
        <span className={'tlbadge' + (r.active ? ' on' : '')}>{r.active ? 'REPLAY' : 'LIVE'}</span>
        <button onClick={() => (r.playing ? pause() : r.active ? play(r.speed) : seek(value, true, r.speed))} title={r.playing ? 'Pause' : 'Abspielen'}>
          {r.playing ? '⏸' : '▶'}
        </button>
        <select value={r.speed} onChange={e => { const s = Number(e.target.value); r.playing ? play(s) : seek(value, false, s); }} title="Tempo">
          {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
        </select>
        <span className="tltime">{r.active ? fmt(value, true) : 'jetzt'}</span>
        <span className="spacer" />
        <button className="tllive" onClick={live} disabled={!r.active} title="Zurück zum Live-Zustand">● Live</button>
        <button onClick={() => { live(); onClose(); }} title="Replay schließen">×</button>
      </div>
      <div className="tltrack">
        {r.marks.filter(m => m.ts >= from).map(m => (
          <i key={m.ts + m.label} className="tlmark" style={{ left: pct(m.ts) }} title={`${fmt(m.ts)} ${m.label}`}
            onClick={() => seek(Math.max(from, m.ts - 30_000), true, r.speed)} />
        ))}
        <input type="range" min={from} max={to} step={1000} value={value}
          onChange={e => setDrag(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} />
      </div>
      <div className="tlscale"><span>{fmt(from, true)}</span><span>{r.marks.length} Warnungen markiert</span><span>jetzt</span></div>
    </div>
  );
}
