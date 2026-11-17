import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { GNode, GraphModel } from './graph';
import { pointsMaterial } from './Particles';
import { getSettings } from './settings';

const MAX = 3000;     // Funken gesamt
const PER_WARN = 14;  // Funken je Warning-Event
const PER_NORMAL = 5; // Funken je Normal-Event
const LIFE = 1400;    // ms
const WARN = new THREE.Color('#ff7a3d').multiplyScalar(1.4);
const NORMAL = new THREE.Color('#8fb4ff');

interface S { node: GNode; t0: number; vx: number; vy: number; vz: number; c: THREE.Color; size: number }

/** Kubernetes-Events als Funken, die kurz am betroffenen Objekt aufsteigen (Warning: mehr, größer, orange). */
export function Sparks({ model }: { model: GraphModel }) {
  const s = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(MAX), 1));
    return { g, mat: pointsMaterial(), live: [] as S[] };
  }, []);

  useFrame(() => {
    const now = performance.now();
    const on = getSettings().sparks;
    for (const e of model.pendingSparks.splice(0)) {
      if (!on) break;
      if (!model.visible(e.node)) continue;
      const n = e.warn ? PER_WARN : PER_NORMAL;
      for (let i = 0; i < n; i++)
        s.live.push({
          node: e.node, t0: now + Math.random() * 150,
          vx: (Math.random() - 0.5) * 8, vy: 6 + Math.random() * 10, vz: (Math.random() - 0.5) * 8,
          c: e.warn ? WARN : NORMAL, size: e.warn ? 3 + Math.random() * 2 : 1.6 + Math.random(),
        });
    }
    if (s.live.length > MAX) s.live.splice(0, s.live.length - MAX);

    const pos = s.g.attributes.position.array as Float32Array;
    const col = s.g.attributes.color.array as Float32Array;
    const siz = s.g.attributes.size.array as Float32Array;
    let k = 0;
    for (let i = s.live.length - 1; i >= 0; i--) {
      const p = s.live[i];
      const t = (now - p.t0) / LIFE;
      if (t > 1) { s.live.splice(i, 1); continue; }
      if (t < 0) continue;
      const f = 1 - t; // ausblenden
      pos[k * 3] = p.node.x + p.vx * t;
      pos[k * 3 + 1] = p.node.y + p.vy * t - 3 * t * t; // steigt auf, leicht abbremsend
      pos[k * 3 + 2] = p.node.z + p.vz * t;
      col[k * 3] = p.c.r * f; col[k * 3 + 1] = p.c.g * f; col[k * 3 + 2] = p.c.b * f;
      siz[k] = p.size * (0.6 + 0.4 * f);
      k++;
    }
    s.g.setDrawRange(0, k);
    s.g.attributes.position.needsUpdate = true;
    s.g.attributes.color.needsUpdate = true;
    s.g.attributes.size.needsUpdate = true;
  });

  return <points geometry={s.g} material={s.mat} frustumCulled={false} />;
}
