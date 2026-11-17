import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls, Stars } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DIE_MS, type GNode, type GraphModel } from './graph';
import { colorOf, heatOf, HOT, HPA_COLORS, MEM_ALERT, pulseOf } from './colors';
import { Particles } from './Particles';
import { Sparks } from './Sparks';
import { NodeField } from './NodeField';
import { useSettings } from './settings';
import { Hulls } from './Hulls';
import type { Res, VolumeMetrics } from './types';

const geo = {
  Namespace: new THREE.SphereGeometry(5, 32, 16),
  Pod: new THREE.SphereGeometry(1.4, 16, 8),
  Deployment: new THREE.OctahedronGeometry(2.6),
  Service: new THREE.TorusGeometry(2.4, 0.35, 8, 32),
  External: new THREE.IcosahedronGeometry(3, 0), // Satellit: externe Quelle
  Ingress: gateGeometry(), // Torbogen (Pfeiler + Halbbogen), Innenfläche separat
  PVC: new THREE.CylinderGeometry(1.5, 1.5, 2.4, 24, 1, true), // Speicher-Zylinder (Mantel), Deckel separat
  Node: new THREE.SphereGeometry(2.2, 24, 12),     // k8s-Node: kleiner leuchtender Kern, Wirkung über Kraftlinien
} as Record<string, THREE.BufferGeometry>;
const portal = gateFill();
const lid = new THREE.CircleGeometry(1.5, 24).rotateX(-Math.PI / 2);          // Deckel (Datenbank-Symbol)
const lidRing = new THREE.TorusGeometry(1.5, 0.12, 6, 24).rotateX(Math.PI / 2); // Ringe am Zylinder
const fillGeo = new THREE.CylinderGeometry(1.3, 1.3, 1, 24).translate(0, 0.5, 0); // Füllstand (Höhe skaliert) // leuchtende Torfläche des Ingress

/** Ingress als Tor: zwei Pfeiler (x = ±2,6, y −3..1) und ein Halbbogen darüber – klar unterscheidbar vom Service-Ring. */
function gateGeometry() {
  const arch = new THREE.TorusGeometry(2.6, 0.35, 8, 32, Math.PI).translate(0, 1, 0);
  const left = new THREE.BoxGeometry(0.7, 4, 0.7).translate(-2.6, -1, 0);
  const right = new THREE.BoxGeometry(0.7, 4, 0.7).translate(2.6, -1, 0);
  const base = new THREE.BoxGeometry(7, 0.35, 1.2).translate(0, -3.1, 0); // Schwelle
  return mergeGeometries([arch.toNonIndexed(), left.toNonIndexed(), right.toNonIndexed(), base.toNonIndexed()].map(g => {
    g.deleteAttribute('uv'); return g;
  }))!;
}
/** Torfläche: Rechteck unter dem Bogen + Halbkreis */
function gateFill() {
  const s = new THREE.Shape();
  s.moveTo(-2.3, -2.9); s.lineTo(2.3, -2.9); s.lineTo(2.3, 1);
  s.absarc(0, 1, 2.3, 0, Math.PI, false);
  s.lineTo(-2.3, -2.9);
  return new THREE.ShapeGeometry(s, 24);
}
const cordonRing = new THREE.TorusGeometry(5, 0.15, 8, 64); // Node unschedulable
// HPA-Ring: Hintergrund + Füllbogen (in 20 Stufen vorab erzeugt)
const hpaBack = new THREE.TorusGeometry(4.4, 0.1, 6, 48);
const hpaArc = Array.from({ length: 21 }, (_, i) => new THREE.TorusGeometry(4.4, 0.28, 6, 48, Math.max(0.05, (i / 20) * Math.PI * 2)));
const hpaFill = (h: Res) => {
  const min = h.minReplicas ?? 1, max = h.maxReplicas ?? 1;
  return max > min ? Math.min(1, Math.max(0, ((h.currentReplicas ?? min) - min) / (max - min))) : 1;
};
const halo = new THREE.SphereGeometry(14, 32, 16);
const hit = new THREE.SphereGeometry(4, 8, 6); // größere unsichtbare Trefferfläche
const HIT_MS = 450; // Dauer des Treffer-Pulses
const hotColor = new THREE.Color(HOT);
const memColor = new THREE.Color(MEM_ALERT);

interface Props {
  model: GraphModel;
  hovered: string | null;
  selected: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  focus: string | null;
  onFocus: (id: string | null) => void;
  onMenu: (id: string, x: number, y: number) => void;
  overview: number;
}

const FOCUS_DIST: Record<string, number> = { PVC: 22, Ingress: 40, Namespace: 120, Node: 140, Deployment: 35, Service: 40, Pod: 18 };

/** Kamera fliegt zum fokussierten Objekt, danach folgt das Orbit-Zentrum dem Objekt (Zoom bleibt frei). */
function Focus({ model, focus }: { model: GraphModel; focus: string | null }) {
  const { camera, controls } = useThree() as unknown as { camera: THREE.Camera; controls: any };
  const start = useRef(0);
  const tmp = useMemo(() => ({ goal: new THREE.Vector3(), delta: new THREE.Vector3(), dir: new THREE.Vector3() }), []);
  useEffect(() => { start.current = performance.now(); }, [focus]);

  useFrame(() => {
    const n = focus ? model.node(focus) : undefined;
    if (!n || !controls) return;
    const t = controls.target as THREE.Vector3;
    tmp.goal.set(n.x, n.y, n.z);
    const flying = performance.now() - start.current < 1200;
    tmp.delta.subVectors(tmp.goal, t).multiplyScalar(flying ? 0.12 : 1);
    t.add(tmp.delta);
    camera.position.add(tmp.delta);
    if (flying) {
      const want = FOCUS_DIST[n.res.kind] ?? 30;
      tmp.dir.subVectors(camera.position, t);
      const d = tmp.dir.length();
      tmp.dir.setLength(d + (want - d) * 0.1);
      camera.position.copy(t).add(tmp.dir);
    }
    controls.update();
  });
  return null;
}

/** Übersicht: Kamera fährt so weit zurück, dass alle sichtbaren Knoten ins Bild passen (Blickrichtung bleibt). */
function Overview({ model, trigger }: { model: GraphModel; trigger: number }) {
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: any };
  const start = useRef(-1e9);
  const tmp = useMemo(() => ({ goal: new THREE.Vector3(), dir: new THREE.Vector3() }), []);
  useEffect(() => { if (trigger) start.current = performance.now(); }, [trigger]);

  useFrame(() => {
    if (!controls || performance.now() - start.current > 1400) return;
    const b = model.bounds();
    const t = controls.target as THREE.Vector3;
    tmp.goal.set(b.cx, b.cy, b.cz).sub(t).multiplyScalar(0.12);
    t.add(tmp.goal);
    camera.position.add(tmp.goal);
    const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
    const half = Math.min(vHalf, Math.atan(Math.tan(vHalf) * camera.aspect));
    const want = Math.max(b.r + 30, 60) / Math.sin(half) * 1.05;
    tmp.dir.subVectors(camera.position, t);
    const d = tmp.dir.length();
    tmp.dir.setLength(d + (want - d) * 0.1);
    camera.position.copy(t).add(tmp.dir);
    controls.update();
  });
  return null;
}

export function Scene(p: Props) {
  const s = useSettings();
  return (
    <Canvas camera={{ position: [0, 80, 420], far: 6000 }} onPointerMissed={() => p.onSelect(null)}>
      <color attach="background" args={['#02010a']} />
      {s.stars && <Stars radius={1200} depth={600} count={8000} factor={7} saturation={0.4} fade speed={0.4} />}
      <OrbitControls makeDefault enableDamping zoomToCursor zoomSpeed={1.6} minDistance={3} maxDistance={3000}
        autoRotate={s.autoRotate && !p.focus} autoRotateSpeed={0.15} />
      <World {...p} />
      <Focus model={p.model} focus={p.focus} />
      <Overview model={p.model} trigger={p.overview} />
      <EffectComposer>
        <Bloom intensity={s.bloom} luminanceThreshold={0.15} luminanceSmoothing={0.3} mipmapBlur />
      </EffectComposer>
    </Canvas>
  );
}

function World(p: Props) {
  useFrame(() => p.model.tick());
  const s = useSettings();
  p.model.trafficPaused = !s.traffic;
  const list = [...p.model.nodes.values(), ...p.model.dying].filter(n => p.model.visible(n));
  list.push(...p.model.satellites.values());
  // Auswahl → zusammenhängende Kette hervorheben, Rest abdunkeln
  const hl = useMemo(() => (p.selected ? p.model.chain(p.selected) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.selected, p.model.links, p.model.satellites.size]);
  p.model.highlight = hl;
  return (
    <>
      {list.map(n => (
        <Body key={n.id} node={n} dim={!!hl && !hl.has(n.id)}
          label={(s.labels && !(hl && !hl.has(n.id)) && (n.res.kind === 'Namespace' || n.res.kind === 'Node' || n.res.kind === 'Ingress' || (n.res.kind === 'External' && !n.dying)))
            || n.id === p.hovered || n.id === p.selected || (!!hl && hl.has(n.id) && n.res.kind !== 'Pod')}
          hpa={n.res.kind === 'Deployment' ? p.model.hpaFor(n.res) : undefined}
          vol={n.res.kind === 'PVC' ? p.model.volumeMetrics[n.id] : undefined}
          selected={n.id === p.selected} onHover={p.onHover} onSelect={p.onSelect} onFocus={p.onFocus} onMenu={p.onMenu} />
      ))}
      {s.hulls && <Hulls model={p.model} />}
      <Links model={p.model} hulls={s.hulls} />
      <NodeField model={p.model} hl={p.hovered ?? p.selected} />
      {s.traffic && <Particles model={p.model} />}
      <Sparks model={p.model} />
    </>
  );
}

function Body({ node, label, selected, dim, hpa, vol, onHover, onSelect, onFocus, onMenu }: {
  node: GNode; label: boolean; selected: boolean; dim: boolean; hpa?: Res; vol?: VolumeMetrics; onHover: Props['onHover']; onSelect: Props['onSelect']; onFocus: Props['onFocus'];
  onMenu: Props['onMenu'];
}) {
  const ring = useRef<THREE.Group>(null);
  const lastReplicas = useRef<number | undefined>(undefined);
  const scaledAt = useRef(0); // HPA hat skaliert → Ring blitzt kurz auf
  const ref = useRef<THREE.Group>(null!);
  const mat = useRef<THREE.MeshBasicMaterial>(null!);
  const target = useMemo(() => new THREE.Color(), []);
  const flash = useMemo(() => new THREE.Color(), []);
  const heat = useRef(0); // geglättete CPU-Hitze
  const isNs = node.res.kind === 'Namespace';
  const isNode = node.res.kind === 'Node';
  const isIng = node.res.kind === 'Ingress';
  const isPvc = node.res.kind === 'PVC';
  const fill = useRef<THREE.Mesh>(null);
  const inner = useRef<THREE.MeshBasicMaterial>(null);
  const big = isNs || isNode;

  useFrame(({ clock }) => {
    const now = performance.now();
    let s = Math.min(1, (now - node.born) / 700);
    s = 1 - Math.pow(1 - s, 3); // ease-out
    if (node.dying) s *= Math.max(0, 1 - (now - node.dying) / DIE_MS);
    const [amp, speed] = pulseOf(node.res);
    if (amp) s *= 1 + amp * Math.sin(clock.elapsedTime * speed);
    if (selected) s *= 1.4;
    if (isNode) s *= 0.7 + 0.15 * Math.sqrt(node.res.cpuCores ?? 4); // Größe nach Kapazität
    // Treffer-Animation: einmal sanft pulsieren (anschwellen und zurück), leicht in Request-Farbe
    const h = node.hitAt ? (now - node.hitAt) / HIT_MS : 1;
    const e = h < 1 ? Math.sin(Math.PI * h) : 0;
    s *= 1 + 0.4 * e;
    // Optional (Prometheus): CPU-Last → größer, heller, glüht orange; Speicher nahe Limit → rotes Pulsieren
    heat.current += (heatOf(node.metrics) - heat.current) * 0.05;
    const hot = heat.current;
    const memAlarm = (node.metrics?.memRel ?? 0) > 0.85 ? 0.5 + 0.5 * Math.sin(clock.elapsedTime * 5) : 0;
    s *= 1 + 0.5 * hot + 0.15 * memAlarm;
    if (dim) s *= 0.8;
    ref.current.position.set(node.x, node.y, node.z);
    ref.current.scale.setScalar(Math.max(s, 0.001));
    if (node.res.kind === 'Service' || node.res.kind === 'External') ref.current.rotation.y += 0.01;
    target.set(colorOf(node.res));
    if (hot > 0.02) target.lerp(hotColor, 0.7 * hot);
    if (memAlarm) target.lerp(memColor, 0.6 * memAlarm);
    target.multiplyScalar(node.dying ? 3 : dim ? 0.18 : 1.8 + 1.4 * hot);
    mat.current.color.lerp(target, 0.08);
    if (e && node.hitColor) mat.current.color.lerp(flash.copy(node.hitColor as THREE.Color).multiplyScalar(2), 0.35 * e);
    if (isNode) ref.current.rotation.y += 0.002;
    if (isIng) {
      // Portal dreht sich langsam zur Seite; Innenfläche schimmert, bei eintreffendem Traffic hell
      ref.current.rotation.y = Math.sin(clock.elapsedTime * 0.3) * 0.6;
      if (inner.current) inner.current.opacity = 0.12 + 0.05 * Math.sin(clock.elapsedTime * 2) + 0.5 * e;
    }
    if (isPvc && fill.current) {
      const v = vol;
      const f = v && v.capacity ? Math.min(1, v.used / v.capacity) : 0;
      fill.current.visible = !!v;
      fill.current.scale.y = Math.max(0.02, f * 2.3);
      (fill.current.material as THREE.MeshBasicMaterial).color.set(f > 0.9 ? '#ff3b5c' : f > 0.75 ? '#ff8a3d' : '#3cf0a0');
    }
    if (ring.current && hpa) {
      if (lastReplicas.current !== undefined && lastReplicas.current !== hpa.currentReplicas) scaledAt.current = now;
      lastReplicas.current = hpa.currentReplicas;
      const g = Math.max(0, 1 - (now - scaledAt.current) / 1500);
      const wob = hpa.status === 'Scaling' ? 0.06 * Math.sin(clock.elapsedTime * 6) : 0;
      ring.current.scale.setScalar(1 + 0.5 * g + wob);
      ring.current.rotation.z += 0.004;
    }
  });

  return (
    <group ref={ref}
      onPointerOver={e => { e.stopPropagation(); onHover(node.id); }}
      onPointerOut={() => onHover(null)}
      onClick={e => { e.stopPropagation(); onSelect(node.id); }}
      onDoubleClick={e => { e.stopPropagation(); onSelect(node.id); onFocus(node.id); }}
      onContextMenu={e => { e.stopPropagation(); e.nativeEvent.preventDefault(); onSelect(node.id); onMenu(node.id, e.nativeEvent.clientX, e.nativeEvent.clientY); }}>
      <mesh geometry={geo[node.res.kind]}>
        <meshBasicMaterial ref={mat} toneMapped={false} color={colorOf(node.res)} transparent={isNode} opacity={isNode ? 0.55 : 1} />
      </mesh>
      {big ? (
        <mesh geometry={halo} scale={isNode ? 0.8 : 1}>
          <meshBasicMaterial color={colorOf(node.res)} transparent opacity={isNode ? 0.025 + 0.12 * (node.metrics?.cpuRel ?? 0) : 0.05}
            depthWrite={false} blending={isNode ? THREE.AdditiveBlending : THREE.NormalBlending} />
        </mesh>
      ) : (
        <mesh geometry={hit}>
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      {isPvc && (
        <>
          <mesh geometry={lid} position={[0, 1.2, 0]}><meshBasicMaterial color={colorOf(node.res)} toneMapped={false} transparent opacity={0.9} /></mesh>
          <mesh geometry={lidRing} position={[0, 0.4, 0]}><meshBasicMaterial color={colorOf(node.res)} toneMapped={false} /></mesh>
          <mesh geometry={lidRing} position={[0, -0.4, 0]}><meshBasicMaterial color={colorOf(node.res)} toneMapped={false} /></mesh>
          <mesh ref={fill} geometry={fillGeo} position={[0, -1.15, 0]} visible={false}><meshBasicMaterial toneMapped={false} /></mesh>
        </>
      )}
      {isIng && (
        <mesh geometry={portal}>
          <meshBasicMaterial ref={inner} color={colorOf(node.res)} transparent opacity={0.15} depthWrite={false}
            side={THREE.DoubleSide} blending={THREE.AdditiveBlending} toneMapped={false} />
        </mesh>
      )}
      {isNode && node.res.unschedulable && (
        <mesh geometry={cordonRing} rotation={[Math.PI / 2, 0, 0]}>
          <meshBasicMaterial color="#9aa0b5" toneMapped={false} />
        </mesh>
      )}
      {hpa && (
        <group ref={ring} rotation={[Math.PI / 2, 0, 0]}>
          <mesh geometry={hpaBack}><meshBasicMaterial color={HPA_COLORS[hpa.status ?? 'Stable']} transparent opacity={0.25} toneMapped={false} /></mesh>
          <mesh geometry={hpaArc[Math.round(hpaFill(hpa) * 20)]}><meshBasicMaterial color={HPA_COLORS[hpa.status ?? 'Stable']} toneMapped={false} /></mesh>
        </group>
      )}
      {label && (
        <Html center zIndexRange={[10, 0]} distanceFactor={big ? 300 : 120} style={{ pointerEvents: 'none' }} position={[0, isNode || isIng ? 6 : isNs ? 9 : 4, 0]}>
          <div className={'label' + (isNs ? ' ns' : isNode ? ' ns node' : '')}>{node.res.kind === 'External' ? `${node.res.name} · ${node.res.status}`
            : isIng ? [...new Set((node.res.rules ?? []).map(r => r.host).filter(Boolean))].join(', ') || node.res.name : node.res.name}</div>
        </Html>
      )}
    </group>
  );
}

const MAX_LINKS = 20000;
const TREE = new THREE.Color('#3a4cff').multiplyScalar(0.6);
const SVC = new THREE.Color('#5ee7ff').multiplyScalar(0.35);
const HOST = new THREE.Color('#ffd98a').multiplyScalar(0.45);
const ING = new THREE.Color('#c78bff').multiplyScalar(0.7);
const VOL = new THREE.Color('#ffb86b').multiplyScalar(0.6);

const DIM = 0.12;
function Links({ model, hulls }: { model: GraphModel; hulls: boolean }) {
  const g = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_LINKS * 6), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_LINKS * 6), 3));
    return geom;
  }, []);

  useFrame(() => {
    const pos = g.attributes.position.array as Float32Array;
    const col = g.attributes.color.array as Float32Array;
    // Pod→Node-Linien zeichnet NodeField (Kraftlinien)
    // Hüllen an: Baum-Linien (Pod→Deployment, →Namespace) übernehmen die Blasen; Service-/Ingress-Linien bleiben
    const links = model.links.filter(l => l.kind !== 'host' && !(hulls && l.kind === 'tree') && model.visible(l.source) && model.visible(l.target)).slice(0, MAX_LINKS);
    const hl = model.highlight;
    links.forEach((l, i) => {
      const a = l.source, b = l.target, o = i * 6;
      pos[o] = a.x; pos[o + 1] = a.y; pos[o + 2] = a.z;
      pos[o + 3] = b.x; pos[o + 4] = b.y; pos[o + 5] = b.z;
      const c = l.kind === 'svc' ? SVC : l.kind === 'host' ? HOST : l.kind === 'ing' ? ING : l.kind === 'vol' ? VOL : TREE;
      const k = hl && !(hl.has(a.id) && hl.has(b.id)) ? DIM : hl ? 1.8 : 1; // Kette hervorheben
      col[o] = col[o + 3] = c.r * k; col[o + 1] = col[o + 4] = c.g * k; col[o + 2] = col[o + 5] = c.b * k;
    });
    g.setDrawRange(0, links.length * 2);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.computeBoundingSphere();
  });

  return (
    <lineSegments geometry={g} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent opacity={0.7} toneMapped={false} />
    </lineSegments>
  );
}
