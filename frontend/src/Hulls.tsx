import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { GraphModel } from './graph';
import { colorOf } from './colors';

const sphere = new THREE.SphereGeometry(1, 40, 24);

// Seifenblase: fast unsichtbar in der Mitte, Rand leuchtet (Fresnel)
const vertexShader = `
  varying vec3 vN; varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const fragmentShader = `
  uniform vec3 color; uniform float strength;
  varying vec3 vN; varying vec3 vV;
  void main() {
    // clamp: dot kann durch Rundung > 1 werden → pow(negativ) = NaN → Bloom färbt das ganze Bild schwarz
    float f = pow(clamp(1.0 - abs(dot(vN, vV)), 0.0, 1.0), 2.4);
    float a = (0.012 + 0.32 * f) * strength;
    gl_FragColor = vec4(color * a, a);
  }`;

/**
 * Hüllen statt Linien: Deployment = Blase um seine Pods, Namespace = große Blase um alles darin.
 * Mittelpunkt und Radius folgen weich dem Layout; außerhalb der hervorgehobenen Kette abgedunkelt.
 */
export function Hulls({ model }: { model: GraphModel }) {
  return (
    <>
      {model.groups.map(g => <Hull key={g.id} model={model} id={g.id} />)}
    </>
  );
}

function Hull({ model, id }: { model: GraphModel; id: string }) {
  const ref = useRef<THREE.Mesh>(null!);
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color() }, strength: { value: 0 } },
    vertexShader, fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }), []);
  const st = useRef({ x: 0, y: 0, z: 0, r: 0, s: 0, init: false });

  useFrame(({ camera }) => {
    const g = model.groups.find(x => x.id === id);
    const owner = g && model.nodes.get(id);
    const live = g?.members.filter(m => !m.dying && model.visible(m)) ?? [];
    const show = !!owner && model.visible(owner) && live.length > (g!.kind === 'Namespace' ? 1 : 0);
    const c = st.current;
    if (show) {
      let x = 0, y = 0, z = 0;
      for (const m of live) { x += m.x; y += m.y; z += m.z; }
      x /= live.length; y /= live.length; z /= live.length;
      let r = 0;
      for (const m of live) r = Math.max(r, Math.hypot(m.x - x, m.y - y, m.z - z));
      r += g!.kind === 'Namespace' ? 10 : 3.2;
      if (!c.init) Object.assign(c, { x, y, z, r, init: true });
      const k = 0.08;
      c.x += (x - c.x) * k; c.y += (y - c.y) * k; c.z += (z - c.z) * k; c.r += (r - c.r) * k;
    }
    const hl = model.highlight;
    // Kamera in der Blase → ausblenden, sonst färbt sie das ganze Bild
    const inside = Math.hypot(camera.position.x - c.x, camera.position.y - c.y, camera.position.z - c.z) / Math.max(c.r, 0.01);
    const fromInside = Math.min(1, Math.max(0, (inside - 0.9) / 0.4));
    const target = !show ? 0 : (g!.kind === 'Namespace' ? 0.55 : 1) * (hl && !hl.has(id) ? 0.15 : 1) * fromInside;
    c.s += (target - c.s) * 0.08;
    ref.current.visible = c.s > 0.01;
    ref.current.position.set(c.x, c.y, c.z);
    ref.current.scale.setScalar(Math.max(c.r, 0.01));
    mat.uniforms.strength.value = c.s;
    if (owner) {
      const col = (mat.uniforms.color.value as THREE.Color).set(colorOf(g!.kind === 'Namespace' ? owner.res : nsRes(model, owner.res.namespace)));
      if (g!.kind === 'Deployment') col.lerp(WHITE, 0.35);
    }
  });

  return <mesh ref={ref} geometry={sphere} material={mat} frustumCulled={false} renderOrder={-1} />;
}

const WHITE = new THREE.Color('#ffffff');
/** Deployment-Hülle in der (aufgehellten) Farbe ihres Namespace */
function nsRes(model: GraphModel, ns?: string) {
  for (const n of model.nodes.values()) if (n.res.kind === 'Namespace' && n.res.name === ns) return n.res;
  return { uid: '', kind: 'Namespace' as const, name: ns ?? '' };
}
