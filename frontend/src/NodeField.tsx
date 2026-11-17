import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { GraphModel } from './graph';
import { getSettings } from './settings';

const SEG = 14;          // Segmente pro Kraftlinie
const MAX = 4000;        // Linien
const COLOR = new THREE.Color('#ffd98a');

/**
 * Pod → Node als „magnetische“ Kraftlinien: sehr transparent, leicht gebogen, mit Lichtwellen,
 * die zum Node hin gesogen werden. Hover/Auswahl eines Pods oder Nodes hebt seine Linien hervor.
 */
export function NodeField({ model, hl }: { model: GraphModel; hl: string | null }) {
  const s = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * SEG * 2 * 3), 3));
    g.setAttribute('u', new THREE.BufferAttribute(new Float32Array(MAX * SEG * 2), 1));      // 0 = Pod, 1 = Node
    g.setAttribute('seed', new THREE.BufferAttribute(new Float32Array(MAX * SEG * 2), 1));
    g.setAttribute('bright', new THREE.BufferAttribute(new Float32Array(MAX * SEG * 2), 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, color: { value: COLOR }, base: { value: 0.05 }, gain: { value: 1 } },
      vertexShader: `
        attribute float u; attribute float seed; attribute float bright;
        varying float vU; varying float vSeed; varying float vBright;
        void main() { vU = u; vSeed = seed; vBright = bright; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float time; uniform vec3 color; uniform float base; uniform float gain;
        varying float vU; varying float vSeed; varying float vBright;
        void main() {
          // Wellen laufen vom Pod zum Node (Sog), zum Node hin dichter und heller
          float wave = pow(0.5 + 0.5 * sin(vU * 14.0 - time * 2.4 + vSeed), 8.0);
          float pull = smoothstep(0.0, 1.0, vU);
          float a = (base + 0.04 * pull + 0.14 * wave * (0.4 + 0.6 * pull)) * (1.0 + 3.0 * vBright) * gain;
          gl_FragColor = vec4(color * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    return { g, mat };
  }, []);

  useFrame(({ clock }) => {
    s.mat.uniforms.time.value = clock.elapsedTime;
    s.mat.uniforms.gain.value = getSettings().nodeLines;
    s.mat.uniforms.base.value = model.layout === 'node' ? 0.0075 : 0.005;
    const pos = s.g.attributes.position.array as Float32Array;
    const uu = s.g.attributes.u.array as Float32Array;
    const sd = s.g.attributes.seed.array as Float32Array;
    const br = s.g.attributes.bright.array as Float32Array;
    let n = 0;
    for (const l of model.links) {
      if (l.kind !== 'host' || n >= MAX) continue;
      const a = l.source, b = l.target;
      if (a.dying || !model.visible(a)) continue;
      const bright = a.id === hl || b.id === hl ? 1 : 0;
      // Kontrollpunkt: Mitte, seitlich und nach oben versetzt (je Pod stabil) → sanft gebogene Feldlinie
      const seed = (a.id.charCodeAt(0) * 7 + a.id.charCodeAt(a.id.length - 1) * 13) % 100 / 10;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const off = len * 0.18;
      const mx = a.x + dx / 2 + Math.sin(seed) * off, my = a.y + dy / 2 + off * 0.6, mz = a.z + dz / 2 + Math.cos(seed) * off;
      for (let i = 0; i < SEG; i++) {
        for (let k = 0; k < 2; k++) {
          const t = (i + k) / SEG, w = 1 - t;
          const v = (n * SEG + i) * 2 + k;
          pos[v * 3] = w * w * a.x + 2 * w * t * mx + t * t * b.x;
          pos[v * 3 + 1] = w * w * a.y + 2 * w * t * my + t * t * b.y;
          pos[v * 3 + 2] = w * w * a.z + 2 * w * t * mz + t * t * b.z;
          uu[v] = t; sd[v] = seed; br[v] = bright;
        }
      }
      n++;
    }
    s.g.setDrawRange(0, n * SEG * 2);
    for (const k of ['position', 'u', 'seed', 'bright']) s.g.attributes[k].needsUpdate = true;
  });

  return <lineSegments geometry={s.g} material={s.mat} frustumCulled={false} />;
}
