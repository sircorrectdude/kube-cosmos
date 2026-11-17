import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { GNode, GraphModel } from './graph';
import type { Flow } from './types';
import { getSettings } from './settings';

const MAX = 6000;          // Partikel (Kometen)
const TRAIL = 7;           // Punkte pro Komet: Kopf + Schweif
const TRAIL_STEP = 0.022;  // Abstand der Schweifpunkte auf der Kurve (Anteil 0..1)
const PER_FLOW = 2;        // Kometen pro Flow
const STAGGER = 90;        // ms zwischen den Kometen eines Flows
const RATE_WINDOW = 2000;  // ms, Zeitkonstante der gleitenden Rate

export const TRAFFIC_COLORS = {
  request: '#5ee7ff', response: '#3cf0a0', error: '#ff3b5c', dropped: '#9aa0b5',
} as const;
const C = Object.fromEntries(Object.entries(TRAFFIC_COLORS).map(([k, v]) => [k, new THREE.Color(v).multiplyScalar(1.15)])) as Record<keyof typeof TRAFFIC_COLORS, THREE.Color>;

type Pt = { x: number; y: number; z: number; dying?: number };
const HIT_THROTTLE = 250; // ms: höchstens eine Treffer-Animation pro Pod in diesem Abstand
interface P { arrived?: boolean; a: Pt; b: Pt; t0: number; dur: number; color: THREE.Color; drop: boolean; lane: number; size: number; jx: number; jy: number; jz: number; seed: number }

function colorFor(f: Flow) {
  if (f.verdict === 'dropped') return C.dropped;
  if (f.verdict === 'error' || (f.httpStatus ?? 0) >= 500) return C.error;
  return f.type === 'request' ? C.request : C.response;
}

/** Stärke 0..1 aus der Rate (Flows/s), logarithmisch: 1/s dünn, ~50/s voll. */
const strength = (rate: number) => Math.min(1, Math.log2(1 + rate) / Math.log2(51));

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Punkte mit individueller Größe (PointsMaterial kann nur eine Größe für alle)
export const pointsMaterial = () => new THREE.ShaderMaterial({
  uniforms: { map: { value: glowTexture() } },
  vertexShader: `
    attribute float size; varying vec3 vColor;
    void main() {
      vColor = color;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = size * (300.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform sampler2D map; varying vec3 vColor;
    void main() { gl_FragColor = vec4(vColor, 1.0) * texture2D(map, gl_PointCoord); }`,
  vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});

const UP = new THREE.Vector3(0, 1, 0);
const tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), m: new THREE.Vector3(), d: new THREE.Vector3() };

/** Kontrollpunkt der Bézierkurve: seitlich versetzt, Requests und Responses auf gegenüberliegenden Bahnen. */
function control(a: Pt, b: Pt, lane: number) {
  tmp.a.set(a.x, a.y, a.z); tmp.b.set(b.x, b.y, b.z);
  tmp.d.subVectors(tmp.b, tmp.a);
  const len = tmp.d.length();
  tmp.m.crossVectors(tmp.d, UP);
  if (tmp.m.lengthSq() < 1e-6) tmp.m.set(1, 0, 0);
  tmp.m.setLength(len * 0.12 * lane).add(tmp.a).addScaledVector(tmp.d, 0.5);
  return tmp.m;
}

function bezier(a: Pt, m: THREE.Vector3, b: Pt, u: number, out: Float32Array, o: number) {
  const w = 1 - u;
  out[o] = w * w * a.x + 2 * w * u * m.x + u * u * b.x;
  out[o + 1] = w * w * a.y + 2 * w * u * m.y + u * u * b.y;
  out[o + 2] = w * w * a.z + 2 * w * u * m.z + u * u * b.z;
}

const easeInOut = (u: number) => u * u * (3 - 2 * u); // sanftes Anfahren und Abbremsen

/** Traffic als Kometen: leuchtender Kopf mit ausblendendem Schweif; Größe und Stromdicke wachsen mit der Rate. */
export function Particles({ model }: { model: GraphModel }) {
  const s = useMemo(() => {
    const pts = new THREE.BufferGeometry();
    pts.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * TRAIL * 3), 3));
    pts.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX * TRAIL * 3), 3));
    pts.setAttribute('size', new THREE.BufferAttribute(new Float32Array(MAX * TRAIL), 1));
    return { pts, mat: pointsMaterial(), live: [] as P[], rates: new Map<string, { r: number; t: number }>() };
  }, []);

  useFrame(() => {
    const now = performance.now();

    // neue Flows übernehmen
    for (const f of model.pendingFlows.splice(0)) {
      // Requests von außerhalb (Ingress, Port-Forward, NodePort) starten/enden an Satelliten (je Eintrittspunkt + Client-Typ)
      const node = (id: string) => (id.startsWith('ext:') ? model.useSatellite(id, f) : model.nodes.get(id));
      const a = node(f.src), b = node(f.dst);
      if (!a || !b) continue;
      // gleitende Rate dieser Verbindung (exponentiell abklingend)
      const key = `${f.src}>${f.dst}`;
      const cur = s.rates.get(key);
      const r = cur ? cur.r * Math.exp(-(now - cur.t) / RATE_WINDOW) + 1 : 1;
      s.rates.set(key, { r, t: now });
      const k = strength(r / (RATE_WINDOW / 1000));
      const size = 2.2 + 4.5 * k;               // Kopfgröße
      const spread = 0.3 + 4 * k;               // Streuung quer zur Bahn = Dicke des Stroms
      const lane = f.type === 'request' ? 1 : -1;
      const color = colorFor(f);
      // Weg wie Kubernetes routet (Satellit → Ingress → …, Pod → Service → Pod); Response nimmt denselben Weg zurück
      const full = !getSettings().routing ? [a, b] : f.type === 'request' ? model.route(a, b) : model.route(b, a).reverse();
      // Namespace-Filter: Weg auf die sichtbaren Stationen kürzen (z.B. Traefik ausgeblendet → Start am Ingress-Tor)
      const path = full.filter(x => model.visible(x));
      if (path.length < 2) continue;
      let t = now;
      for (let h = 0; h < path.length - 1; h++) {
        const pa = path[h], pb = path[h + 1];
        const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
        const dur = path.length > 2 ? Math.min(1300, Math.max(420, dist * 8)) : Math.min(1800, Math.max(600, dist * 9));
        const last = h === path.length - 2;
        for (let i = 0; i < PER_FLOW; i++)
          s.live.push({
            a: pa, b: pb, t0: t + i * STAGGER, dur, color, drop: last && f.verdict === 'dropped', lane, size,
            jx: (Math.random() - 0.5) * spread, jy: (Math.random() - 0.5) * spread, jz: (Math.random() - 0.5) * spread,
            seed: Math.random() * 100,
          });
        t += dur * 0.85; // nächster Abschnitt startet kurz bevor der Kopf ankommt → fließender Übergang
      }
    }
    if (s.live.length > MAX) s.live.splice(0, s.live.length - MAX);
    if (s.rates.size > 2000) s.rates.clear();

    const pos = s.pts.attributes.position.array as Float32Array;
    const col = s.pts.attributes.color.array as Float32Array;
    const siz = s.pts.attributes.size.array as Float32Array;
    let n = 0;
    const hl = model.highlight;
    for (let i = s.live.length - 1; i >= 0; i--) {
      const p = s.live[i];
      const dim = hl && !((hl.has((p.a as GNode).id) && hl.has((p.b as GNode).id))) ? 0.15 : 1;
      const raw = (now - p.t0) / p.dur;
      const end = p.drop ? 0.55 : 1 + TRAIL * TRAIL_STEP; // Schweif läuft noch ins Ziel ein
      if (raw > end || p.a.dying || p.b.dying) { s.live.splice(i, 1); continue; }
      if (raw < 0) continue;
      if (!p.arrived && !p.drop && raw >= 1) {   // Kopf ist angekommen → Ziel-Pod reagiert
        p.arrived = true;
        const t = p.b as GNode;
        if (!t.hitAt || now - t.hitAt > HIT_THROTTLE) { t.hitAt = now; t.hitColor = p.color; }
      }
      const m = control(p.a, p.b, p.lane);
      const twinkle = 0.85 + 0.15 * Math.sin(now * 0.02 + p.seed);
      // dropped: verglimmt zur Mitte hin
      const dropFade = p.drop ? Math.max(0, 1 - raw / 0.55) : 1;
      for (let j = 0; j < TRAIL; j++) {
        const uj = raw - j * TRAIL_STEP;
        if (uj < 0 || uj > 1) continue;
        const u = easeInOut(uj);
        const o = n * 3;
        bezier(p.a, m, p.b, u, pos, o);
        const env = Math.sin(Math.PI * u); // Streuung in der Mitte am größten, an den Enden gebündelt
        pos[o] += p.jx * env; pos[o + 1] += p.jy * env; pos[o + 2] += p.jz * env;
        const tail = Math.pow(1 - j / TRAIL, 1.6);                 // Schweif wird dunkler …
        const arrive = uj > 0.92 && j === 0 ? 1 + (uj - 0.92) * 12 : 1; // … Kopf blitzt beim Eintreffen auf
        const bright = tail * dropFade * twinkle * arrive * dim;
        col[o] = p.color.r * bright; col[o + 1] = p.color.g * bright; col[o + 2] = p.color.b * bright;
        siz[n] = p.size * (1 - 0.65 * (j / TRAIL)) * (j === 0 ? arrive : 1);  // … und schmaler
        n++;
      }
    }
    s.pts.setDrawRange(0, n);
    s.pts.attributes.position.needsUpdate = true;
    s.pts.attributes.color.needsUpdate = true;
    s.pts.attributes.size.needsUpdate = true;
  });

  return <points geometry={s.pts} material={s.mat} frustumCulled={false} />;
}
