import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { ClusterState } from './k8s.js';
import { setStatus } from './status.js';

/** Eine Zeile der Aufzeichnung: Zeitpunkt (ms) + WS-Nachricht (upsert/delete/event) oder Keyframe (voller Zustand). */
export interface Entry { ts: number; m: any }
export interface Mark { ts: number; label: string }

const HOUR = 3_600_000;

/**
 * Zeichnet die Cluster-Deltas auf: je Stunde eine NDJSON-Datei (rec/2026-11-17T10.ndjson),
 * jede Datei beginnt mit einem Keyframe, danach alle REPLAY_KEYFRAME_SEC ein weiterer. Alte Dateien werden gelöscht.
 */
export class Recorder {
  enabled = false;
  private dir = config.replayDir;
  private file = '';
  private buf = new Map<string, string[]>();
  private marks = new Map<string, { size: number; marks: Mark[] }>(); // Cache je Datei

  constructor(private state: ClusterState) {}

  start() {
    if (!this.dir) { setStatus('replay', 'Replay', 'off', 'REPLAY_DIR leer'); return; }
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.accessSync(this.dir, fs.constants.W_OK); }
    catch (e: any) { setStatus('replay', 'Replay', 'warn', `Verzeichnis ${this.dir} nicht beschreibbar – keine Aufzeichnung`); return; }
    this.enabled = true;
    this.state.onDelta(d => this.write(d));
    this.write(this.keyframe());
    setInterval(() => this.write(this.keyframe()), config.replayKeyframeMs).unref();
    setInterval(() => this.flush(), 1000).unref();
    setInterval(() => this.prune(), 10 * 60_000).unref();
    this.prune();
  }

  private keyframe() { return { type: 'keyframe', ...this.state.snapshot() }; }
  private fileFor(ts: number) { return path.join(this.dir, new Date(ts).toISOString().slice(0, 13) + '.ndjson'); }

  private write(m: any, ts = Date.now()) {
    const f = this.fileFor(ts);
    if (f !== this.file) { // neue Stunde: Datei beginnt immer mit einem Keyframe
      this.file = f;
      if (m.type !== 'keyframe') this.push(f, { ts, m: this.keyframe() });
    }
    this.push(f, { ts, m });
  }
  private push(f: string, e: Entry) {
    const b = this.buf.get(f) ?? []; b.push(JSON.stringify(e)); this.buf.set(f, b);
  }
  flush() {
    for (const [f, lines] of this.buf) {
      try { fs.appendFileSync(f, lines.join('\n') + '\n'); } catch (e: any) { console.warn(`[replay] ${e.message}`); }
    }
    this.buf.clear();
  }

  private prune() {
    const cutoff = Date.now() - config.replayRetentionH * HOUR;
    for (const f of this.files()) if (f.start + HOUR < cutoff) { try { fs.unlinkSync(f.path); this.marks.delete(f.path); } catch { /* egal */ } }
    const fs_ = this.files();
    setStatus('replay', 'Replay', 'ok', fs_.length
      ? `Aufzeichnung seit ${new Date(fs_[0].start).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${config.replayRetentionH} h`
      : 'Aufzeichnung läuft');
  }

  /** Aufzeichnungsdateien, aufsteigend nach Stunde. */
  files() {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter(n => /^\d{4}-\d\d-\d\dT\d\d\.ndjson$/.test(n)).sort(); } catch { /* leer */ }
    return names.map(n => ({ path: path.join(this.dir, n), start: Date.parse(n.slice(0, 13) + ':00:00Z') }));
  }

  read(file: string): Entry[] {
    if (this.buf.has(file)) this.flush();
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out: Entry[] = [];
    for (const line of text.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* abgeschnittene Zeile */ } }
    return out;
  }

  /** Zeitraum + Markierungen (Warn-Events, gleiche Meldung höchstens 1×/min). */
  range() {
    this.flush();
    const files = this.files();
    const marks: Mark[] = [];
    let from = Date.now();
    for (const f of files) {
      let size = 0; try { size = fs.statSync(f.path).size; } catch { continue; }
      let c = this.marks.get(f.path);
      if (!c || c.size !== size) {
        const seen = new Map<string, number>(), ms: Mark[] = [];
        for (const e of this.read(f.path)) {
          const ev = e.m.type === 'event' ? e.m.event : undefined;
          if (ev?.type !== 'Warning') continue;
          const key = `${ev.reason} ${ev.namespace ?? ''}/${ev.object ?? ''}`;
          if (e.ts - (seen.get(key) ?? 0) < 60_000) continue;
          seen.set(key, e.ts);
          ms.push({ ts: e.ts, label: `${ev.reason} · ${ev.namespace ? ev.namespace + '/' : ''}${ev.object ?? ''}` });
        }
        c = { size, marks: ms }; this.marks.set(f.path, c);
      }
      marks.push(...c.marks);
    }
    if (files.length) from = this.read(files[0].path)[0]?.ts ?? files[0].start;
    return { from, to: Date.now(), marks: marks.slice(-500) };
  }
}

/** Abspielen für einen Client: Zustand zum Zeitpunkt rekonstruieren, dann Deltas mit Originaltiming × speed senden. */
export class Player {
  private entries: Entry[] = [];
  private idx = 0;
  private fileStart = 0;
  private ts = 0;
  private speed = 1;
  private playing = false;
  private anchor = { wall: 0, ts: 0 };
  private timer?: NodeJS.Timeout;
  private clockTimer?: NodeJS.Timeout;
  private reread = 0;

  constructor(private rec: Recorder, private send: (m: object) => void, private onEnd: () => void) {}

  now() { return this.playing ? this.anchor.ts + (Date.now() - this.anchor.wall) * this.speed : this.ts; }

  seek(ts: number, play: boolean, speed?: number) {
    this.halt();
    if (speed) this.speed = speed;
    const files = this.rec.files();
    if (!files.length) return this.onEnd();
    let f = files.filter(x => x.start <= ts).at(-1) ?? files[0];
    this.entries = this.rec.read(f.path); this.fileStart = f.start;
    let k = -1;
    for (let i = 0; i < this.entries.length && this.entries[i].ts <= ts; i++) if (this.entries[i].m.type === 'keyframe') k = i;
    if (k < 0) { k = this.entries.findIndex(e => e.m.type === 'keyframe'); if (k < 0) return this.onEnd(); ts = Math.max(ts, this.entries[k].ts); }
    // Zustand aufbauen: Keyframe + Deltas bis ts
    const kf = this.entries[k].m;
    const res = new Map<string, any>(kf.resources.map((r: any) => [r.uid, r]));
    const events: any[] = [...(kf.events ?? [])];
    let i = k + 1;
    for (; i < this.entries.length && this.entries[i].ts <= ts; i++) {
      const m = this.entries[i].m;
      if (m.type === 'upsert') res.set(m.res.uid, m.res);
      else if (m.type === 'delete') res.delete(m.uid);
      else if (m.type === 'event') events.push(m.event);
    }
    this.idx = i;
    this.ts = ts;
    this.send({ type: 'replay:state', ts, resources: [...res.values()], events: events.slice(-100) });
    play ? this.play(this.speed) : this.clock();
  }

  play(speed: number) {
    this.halt();
    this.speed = Math.min(Math.max(speed || 1, 0.25), 600);
    this.anchor = { wall: Date.now(), ts: this.ts };
    this.playing = true;
    this.timer = setInterval(() => this.tick(), 100);
    this.clockTimer = setInterval(() => this.clock(), 2000);
    this.clock();
  }

  pause() { this.ts = this.now(); this.halt(); this.clock(); }

  stop() { this.halt(); }

  private halt() {
    if (this.playing) this.ts = this.now();
    this.playing = false;
    clearInterval(this.timer); clearInterval(this.clockTimer);
  }

  private clock() { this.send({ type: 'replay:clock', ts: this.now(), playing: this.playing, speed: this.speed }); }

  private tick() {
    const t = this.now();
    if (t >= Date.now() - 1000) { this.halt(); return this.onEnd(); } // Gegenwart erreicht → live
    while (true) {
      while (this.idx < this.entries.length && this.entries[this.idx].ts <= t) {
        const m = this.entries[this.idx++].m;
        if (m.type !== 'keyframe') this.send(m);
      }
      if (this.idx < this.entries.length) return;
      const files = this.rec.files();
      const next = files.find(x => x.start > this.fileStart);
      if (!next || next.start > t) {
        // laufende Stunde wächst noch: höchstens alle 2 s neu einlesen
        if (!next && Date.now() - this.reread > 2000) {
          this.reread = Date.now();
          const fresh = this.rec.read(files.find(x => x.start === this.fileStart)?.path ?? '');
          if (fresh.length > this.entries.length) { this.entries = fresh; continue; }
        }
        return;
      }
      this.entries = this.rec.read(next.path); this.fileStart = next.start; this.idx = 0;
    }
  }
}
