import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceZ } from 'd3-force-3d';
import type { Flow, NodeMetrics, PodMetrics, Res, VolumeMetrics } from './types';

export interface Satellite extends GNode { seen: number; until: number; ingress?: string }
export interface SatStats { since: number; requests: number; errors: number; rate: number; rateAt: number; clients: Map<string, number>; paths: Map<string, number> }
const bump = (m: Map<string, number>, k: string) => { if (m.size < 300 || m.has(k)) m.set(k, (m.get(k) ?? 0) + 1); };
/** Top-N einer Zählmap */
export const top = (m: Map<string, number>, n = 5) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);

export interface GNode {
  id: string;
  res: Res;
  x: number; y: number; z: number;
  born: number;
  dying?: number;
  /** Zeitpunkt + Farbe des letzten eintreffenden Requests (für die Treffer-Animation) */
  hitAt?: number;
  hitColor?: { r: number; g: number; b: number };
  /** optional aus Prometheus */
  metrics?: PodMetrics;
  /** d3-force: fixierte Position (Nodes in der Namespace-Ansicht) */
  fx?: number | null; fy?: number | null; fz?: number | null;
}
export interface GLink { source: GNode; target: GNode; kind: 'tree' | 'svc' | 'host' | 'ing' | 'vol'; dist: number; str: number }
export type Layout = 'ns' | 'node';
const LAYOUT_KEY = 'kube-cosmos.layout';

export const DIE_MS = 1200;
const INGRESS_HIT = { r: 0.95, g: 0.75, b: 1 };

const matches = (sel: Record<string, string> | undefined, labels: Record<string, string> | undefined) =>
  !!sel && Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels?.[k] === v);

/** Hält Graph-Knoten persistent (Positionen bleiben bei Updates erhalten) und betreibt das Force-Layout. */
export class GraphModel {
  nodes = new Map<string, GNode>();
  dying: GNode[] = [];
  links: GLink[] = [];
  k8sNodes = new Map<string, Res>();
  /** Eingehende Traffic-Flows; werden von Particles pro Frame abgeholt. */
  pendingFlows: Flow[] = [];
  /** Traffic-Animation aus (Einstellung): Flows verwerfen statt puffern */
  trafficPaused = false;
  addFlows(f: Flow[]) { if (!this.trafficPaused && this.pendingFlows.length < 5000) this.pendingFlows.push(...f); }

  /** Namespace-Filter: nur dieser Namespace ist sichtbar (null = alle). */
  nsFilter: string | null = null;
  setNsFilter(ns: string | null) { this.nsFilter = ns; this.notify(); }
  visible(n: { res: Res }) {
    const k = n.res.kind;
    if (k === 'External') return true;
    if (this.layout === 'node' && (k === 'Namespace' || k === 'Deployment' || k === 'Service' || k === 'Ingress' || k === 'PVC')) return false;
    if (k === 'Node') return true;
    const f = this.nsFilter;
    return !f || (n.res.kind === 'Namespace' ? n.res.name === f : n.res.namespace === f);
  }

  /** Optionale Metriken (Prometheus): an die Pod-Knoten hängen. */
  metricsSource?: string;
  nodeMetrics: Record<string, NodeMetrics> = {};
  podMetrics: Record<string, PodMetrics> = {};
  /** Füllstand je PVC-UID (optional, kubelet_volume_stats) */
  volumeMetrics: Record<string, VolumeMetrics> = {};
  applyMetrics(pods: Record<string, PodMetrics>, nodes: Record<string, NodeMetrics>, volumes?: Record<string, VolumeMetrics>) {
    this.volumeMetrics = volumes ?? {};
    this.podMetrics = pods;
    this.nodeMetrics = nodes;
    for (const n of this.nodes.values()) {
      if (n.res.kind === 'Pod') n.metrics = pods[n.id];
      // Node-Auslastung (Anteil 0..1) in dieselbe Form bringen → Body glüht wie bei Pods
      if (n.res.kind === 'Node') {
        const m = nodes[n.res.name];
        n.metrics = m && { cpu: m.cpu * (n.res.cpuCores ?? 1), cpuRel: m.cpu, mem: m.mem * (n.res.memGi ?? 0) * 1073741824, memRel: m.mem };
      }
    }
    this.notify();
  }
  /** Ansicht: nach Namespaces (Nodes als Sonnen unterhalb) oder nach Nodes (Pods kreisen um ihren Node). */
  layout: Layout = (() => { try { return localStorage.getItem(LAYOUT_KEY) === 'node' ? 'node' : 'ns'; } catch { return 'ns'; } })();
  setLayout(l: Layout) {
    this.layout = l;
    try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* egal */ }
    if (l === 'node') for (const n of this.nodes.values()) if (n.res.kind === 'Node') n.fx = n.fy = n.fz = null;
    this.rebuild();
    this.sim.alpha(1);
  }

  /** HPAs (kein eigener Knoten, Ring am Ziel-Deployment). */
  hpas = new Map<string, Res>();
  hpaFor(r: Res) {
    for (const h of this.hpas.values()) if (h.namespace === r.namespace && h.target === r.name) return h;
  }

  /** Event-Funken: werden von Sparks pro Frame abgeholt. */
  pendingSparks: { node: GNode; warn: boolean }[] = [];
  sparkEvent(e: { namespace?: string; object?: string; type?: string }) {
    const n = this.eventTarget(e);
    if (n && this.pendingSparks.length < 200) this.pendingSparks.push({ node: n, warn: e.type === 'Warning' });
  }

  /** Objekt eines Events im Graph (ReplicaSet → Deployment, HPA → Ziel-Deployment, sonst Namespace). */
  eventTarget(e: { namespace?: string; object?: string }) {
    const [kind, name = ''] = (e.object ?? '').split('/');
    const find = (k: string, nm: string) => {
      for (const n of this.nodes.values())
        if (n.res.kind === k && n.res.name === nm && (k === 'Node' || k === 'Namespace' || n.res.namespace === e.namespace)) return n;
    };
    // Kind-Namen der Events → eigene Kinds
    let n = find(({ PersistentVolumeClaim: 'PVC', HorizontalPodAutoscaler: 'HPA' } as Record<string, string>)[kind] ?? kind, name);
    if (!n && kind === 'ReplicaSet') n = find('Deployment', name.replace(/-[a-z0-9]+$/, ''));
    if (!n && kind === 'HorizontalPodAutoscaler') {
      const h = [...this.hpas.values()].find(x => x.name === name && x.namespace === e.namespace);
      if (h?.target) n = find('Deployment', h.target);
    }
    if (!n && e.namespace) n = find('Namespace', e.namespace);
    return n;
  }

  private listeners = new Set<() => void>();
  private pending = false;

  sim = forceSimulation([], 3)
    .force('charge', forceManyBody().strength((n: GNode) => this.charge(n)).distanceMax(400))
    .force('link', forceLink([]).distance((l: GLink) => l.dist).strength((l: GLink) => l.str))
    .force('x', forceX(0).strength((n: GNode) => this.center(n)))
    .force('y', forceY(0).strength((n: GNode) => this.center(n)))
    .force('z', forceZ(0).strength((n: GNode) => this.center(n)))
    .alphaDecay(0.02)
    .stop();

  /** Anker der Ansicht: Namespaces bzw. Nodes stoßen sich ab und werden zur Mitte gezogen. */
  private charge(n: GNode) {
    const k = n.res.kind;
    if (this.layout === 'node') return k === 'Node' ? -1200 : k === 'Pod' ? -12 : 0;
    return k === 'Namespace' ? -900 : k === 'Node' ? 0 : -12;
  }
  private center(n: GNode) { return n.res.kind === (this.layout === 'node' ? 'Node' : 'Namespace') ? 0.03 : 0; }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  sync(all: Res[]) {
    const keep = new Set(all.map(r => r.uid));
    for (const id of [...this.nodes.keys()]) if (!keep.has(id)) this.remove(id);
    for (const id of [...this.k8sNodes.keys()]) if (!keep.has(id)) this.k8sNodes.delete(id);
    for (const id of [...this.hpas.keys()]) if (!keep.has(id)) this.hpas.delete(id);
    all.forEach(r => this.upsert(r));
  }

  upsert(res: Res) {
    if (res.kind === 'HPA') { this.hpas.set(res.uid, res); this.notify(); return; }
    if (res.kind === 'Node') this.k8sNodes.set(res.uid, res);
    const n = this.nodes.get(res.uid);
    if (n) { n.res = res; this.schedule(); return; }
    const ns = [...this.nodes.values()].find(o => o.res.kind === 'Namespace' && o.res.name === res.namespace);
    const r = () => (Math.random() - 0.5) * (ns ? 30 : 300);
    this.nodes.set(res.uid, { id: res.uid, res, x: (ns?.x ?? 0) + r(), y: (ns?.y ?? 0) + r(), z: (ns?.z ?? 0) + r(), born: performance.now(), metrics: this.podMetrics[res.uid] });
    this.schedule();
  }

  remove(uid: string) {
    if (this.hpas.delete(uid)) { this.notify(); return; }
    this.k8sNodes.delete(uid);
    const n = this.nodes.get(uid);
    if (!n) return;
    this.nodes.delete(uid);
    n.dying = performance.now();
    this.dying.push(n);
    setTimeout(() => { this.dying = this.dying.filter(d => d !== n); this.notify(); }, DIE_MS);
    this.schedule();
  }

  tick() {
    if (this.sim.alpha() > this.sim.alphaMin()) this.sim.tick();
    const now = performance.now();
    if (now - this.satCheck > 1000) { this.satCheck = now; this.expireSatellites(now); this.placeSuns(); }
    // Namespace-Ansicht: Nodes gleiten als Sonnen auf einen Ring unterhalb der Galaxien
    if (this.layout === 'ns') for (const n of this.nodes.values()) {
      const t = this.sunAt.get(n.id);
      if (!t) continue;
      n.x = n.fx = n.x + (t[0] - n.x) * 0.04;
      n.y = n.fy = n.y + (t[1] - n.y) * 0.04;
      n.z = n.fz = n.z + (t[2] - n.z) * 0.04;
    }
  }

  private sunAt = new Map<string, [number, number, number]>();
  private placeSuns() {
    if (this.layout !== 'ns') return;
    const suns = [...this.nodes.values()].filter(n => n.res.kind === 'Node').sort((a, b) => a.res.name.localeCompare(b.res.name));
    const ns = [...this.nodes.values()].filter(n => n.res.kind === 'Namespace' && this.visible(n));
    if (!suns.length || !ns.length) return;
    let cx = 0, cz = 0, minY = Infinity, r = 0;
    for (const n of ns) { cx += n.x; cz += n.z; minY = Math.min(minY, n.y); }
    cx /= ns.length; cz /= ns.length;
    for (const n of ns) r = Math.max(r, Math.hypot(n.x - cx, n.z - cz));
    const R = Math.max(80, r * 0.7);
    suns.forEach((n, i) => {
      const a = (i / suns.length) * Math.PI * 2;
      this.sunAt.set(n.id, [cx + R * Math.cos(a), minY - 110, cz + R * Math.sin(a)]);
    });
  }

  /**
   * Externe Quellen als Satelliten (je Eintrittspunkt + Client-Typ), kein zentraler Knoten.
   * Entstehen an zufälliger Stelle im Raum um den Cluster, leben 30–80 s und verglühen dann
   * (bei weiterem Traffic entsteht derselbe Satellit woanders neu); ohne Traffic nach 15 s weg.
   */
  satellites = new Map<string, Satellite>();
  satStats = new Map<string, SatStats>();
  private satCheck = 0;
  private satGen = 0;
  useSatellite(id: string, f: Flow) {
    const now = performance.now();
    let n = this.satellites.get(id);
    if (!n) {
      const [entry, agent] = (f.ext ? [f.ext.entry, f.ext.agent] : id.slice(4).split('|')) as [string, string];
      const p = this.randomSpot();
      n = { id, ...p, born: now, seen: now, until: now + 30_000 + Math.random() * 50_000,
        res: { uid: id, kind: 'External', name: entry, status: agent ?? 'unbekannt' } };
      n.ingress = this.ingressForEntry(entry)?.id;
      this.satellites.set(id, n);
      this.notify();
    }
    n.seen = now;
    if (f.type === 'request' && n.ingress) {
      const ing = this.nodes.get(n.ingress);
      if (ing && (!ing.hitAt || now - ing.hitAt > 250)) { ing.hitAt = now; ing.hitColor = INGRESS_HIT; }
    }
    if (f.ext) {
      let st = this.satStats.get(id);
      if (!st) this.satStats.set(id, st = { since: Date.now(), requests: 0, errors: 0, rate: 0, rateAt: now, clients: new Map(), paths: new Map() });
      if (f.type === 'request') {
        st.requests++;
        st.rate = st.rate * Math.exp(-(now - st.rateAt) / 5000) + 1; st.rateAt = now;
        bump(st.clients, f.ext.ip); bump(st.paths, `${f.httpMethod ?? ''} ${f.ext.path}`);
      } else if ((f.httpStatus ?? 0) >= 500) st.errors++;
    }
    return n;
  }
  private expireSatellites(now: number) {
    for (const [id, n] of this.satellites) {
      if (now - n.seen < 15_000 && now < n.until) continue;
      this.satellites.delete(id);
      // eigene ID für die Sterbe-Animation, damit ein Neugeborener mit derselben ID nicht kollidiert
      const d = { ...n, id: `${id}#${++this.satGen}`, dying: now };
      this.dying.push(d);
      setTimeout(() => { this.dying = this.dying.filter(o => o !== d); this.notify(); }, DIE_MS);
      if (now - n.seen >= 15_000) this.satStats.delete(id);
      this.notify();
    }
  }
  /** Zufälliger Punkt auf einer Schale um die sichtbaren Knoten. */
  /** Schwerpunkt + Radius aller sichtbaren Knoten (Übersicht, Satelliten-Schale). */
  bounds() {
    let cx = 0, cy = 0, cz = 0, k = 0, r = 0;
    for (const o of this.nodes.values()) if (this.visible(o)) { cx += o.x; cy += o.y; cz += o.z; k++; }
    if (k) { cx /= k; cy /= k; cz /= k; }
    for (const o of this.nodes.values()) if (this.visible(o)) r = Math.max(r, Math.hypot(o.x - cx, o.y - cy, o.z - cz));
    return { cx, cy, cz, r };
  }
  private randomSpot() {
    const { cx, cy, cz, r } = this.bounds();
    const d = (r || 100) * (0.6 + Math.random() * 0.5) + 30;
    const u = Math.random() * 2 - 1, phi = Math.random() * Math.PI * 2, q = Math.sqrt(1 - u * u);
    return { x: cx + d * q * Math.cos(phi), y: cy + d * u, z: cz + d * q * Math.sin(phi) };
  }
  /** Ingress zu einem Eintrittspunkt: Traefik-Router „<ns>-<ingress>-<host…>“ (ohne @provider). */
  ingressForEntry(entry: string) {
    let best: GNode | undefined;
    for (const n of this.nodes.values())
      if (n.res.kind === 'Ingress' && entry.startsWith(`${n.res.namespace}-${n.res.name}-`) && (!best || n.res.name.length > best.res.name.length)) best = n;
    return best;
  }
  /** Satelliten, die über diesen Ingress hereinkommen */
  satellitesOf(ingressId: string) { return [...this.satellites.values()].filter(s => s.ingress === ingressId); }

  /** Beziehungen (unabhängig von Ansicht/Links), in rebuild() berechnet. */
  rel = {
    podDep: new Map<string, string>(), depPods: new Map<string, string[]>(),
    podSvcs: new Map<string, string[]>(), svcPods: new Map<string, string[]>(),
    svcIngs: new Map<string, string[]>(), ingSvcs: new Map<string, string[]>(),
    podPvcs: new Map<string, string[]>(), pvcPods: new Map<string, string[]>(),
  };
  /** Hervorgehobene Kette (Auswahl) – null = nichts abdunkeln. Von Scene gesetzt, von Particles/Links/Hüllen gelesen. */
  highlight: Set<string> | null = null;

  /** Alles, was logisch mit id zusammenhängt: Ingress ↔ Services ↔ Pods ↔ Deployment, plus Namespace und Satelliten. */
  chain(id: string): Set<string> | null {
    const n = this.node(id);
    if (!n) return null;
    const S = new Set<string>([id]);
    const r = this.rel;
    const get = (m: Map<string, string[]>, k: string) => m.get(k) ?? [];
    const pod = (p: string) => { S.add(p); const d = r.podDep.get(p); if (d) S.add(d); get(r.podPvcs, p).forEach(v => S.add(v)); };
    const svc = (s: string, up = true) => {
      S.add(s); get(r.svcPods, s).forEach(p => pod(p));
      if (up) get(r.svcIngs, s).forEach(i => S.add(i));
    };
    const ingress = (i: string) => { S.add(i); get(r.ingSvcs, i).forEach(s => svc(s, false)); };
    const podUp = (p: string) => { pod(p); get(r.podSvcs, p).forEach(s => { S.add(s); get(r.svcIngs, s).forEach(i => S.add(i)); }); };
    switch (n.res.kind) {
      case 'External': { const i = (n as Satellite).ingress; if (i) ingress(i); break; }
      case 'Ingress': ingress(id); break;
      case 'Service': svc(id); break;
      case 'Deployment': get(r.depPods, id).forEach(podUp); break;
      case 'Pod': podUp(id); break;
      case 'PVC': get(r.pvcPods, id).forEach(podUp); break;
      case 'Node': for (const o of this.nodes.values()) if (o.res.kind === 'Pod' && o.res.nodeName === n.res.name) S.add(o.id); break;
      case 'Namespace': for (const o of this.nodes.values()) if (o.res.namespace === n.res.name) S.add(o.id); break;
    }
    // Namespace(s) der Kette und Satelliten ihrer Ingresses dazu
    for (const k of [...S]) {
      const o = this.nodes.get(k);
      if (o?.res.namespace) for (const x of this.nodes.values()) if (x.res.kind === 'Namespace' && x.res.name === o.res.namespace) S.add(x.id);
      if (o?.res.kind === 'Ingress') for (const s of this.satellitesOf(k)) S.add(s.id);
    }
    return S;
  }

  /**
   * Weg eines Requests: Satellit → Ingress-Tor → Ziel bzw. Pod → Service → Pod (wie Kubernetes routet).
   * Liefert die Wegpunkte inkl. Start und Ziel; ohne passende Zwischenstation direkt [a, b].
   */
  route(a: GNode, b: GNode): GNode[] {
    // Externe Requests landen beim Ingress-Controller (Traefik) – der ist der echte erste Hop
    if (a.res.kind !== 'Pod' || b.res.kind !== 'Pod') return [a, b];
    const ok = (x?: GNode) => !!x && this.visible(x) && !x.dying;
    const s = (this.rel.podSvcs.get(b.id) ?? []).map(id => this.nodes.get(id)).find(ok);
    if (!s || this.rel.podDep.get(a.id) === this.rel.podDep.get(b.id)) return [a, b];
    // Controller → Ingress-Regel → Service → Pod
    if (isIngressController(a.res)) {
      const ing = (this.rel.svcIngs.get(s.id) ?? []).map(id => this.nodes.get(id)).find(ok);
      if (ing) return [a, ing, s, b];
    }
    return [a, s, b];
  }

  /** Hüllen: Deployment → seine Pods, Namespace → alle seine Objekte. */
  groups: { id: string; kind: 'Deployment' | 'Namespace'; members: GNode[] }[] = [];

  /** Knoten per ID, inkl. Satelliten. */
  node(id: string): GNode | undefined { return this.nodes.get(id) ?? this.satellites.get(id); }

  /** Strukturänderungen gebündelt pro Frame verarbeiten. */
  private schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.rebuild(); });
  }

  rebuild() {
    const all = [...this.nodes.values()];
    const nsByName = new Map(all.filter(n => n.res.kind === 'Namespace').map(n => [n.res.name, n]));
    const deps = all.filter(n => n.res.kind === 'Deployment');
    const pods = all.filter(n => n.res.kind === 'Pod');
    const hosts = new Map(all.filter(n => n.res.kind === 'Node').map(n => [n.res.name, n]));
    const links: GLink[] = [];
    const byNode = this.layout === 'node';
    // Beziehungen (für Kette, Routing, Hüllen) – unabhängig von der Ansicht
    const r = this.rel;
    for (const m of Object.values(r)) m.clear();
    const push = (m: Map<string, string[]>, k: string, v: string) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
    const svcNodes = all.filter(n => n.res.kind === 'Service');
    for (const p of pods) {
      const d = deps.find(x => x.res.namespace === p.res.namespace && matches(x.res.selector, p.res.labels));
      if (d) { r.podDep.set(p.id, d.id); push(r.depPods, d.id, p.id); }
      for (const s of svcNodes)
        if (s.res.namespace === p.res.namespace && matches(s.res.selector, p.res.labels)) { push(r.podSvcs, p.id, s.id); push(r.svcPods, s.id, p.id); }
    }
    const pvcByName = new Map(all.filter(n => n.res.kind === 'PVC').map(n => [`${n.res.namespace}/${n.res.name}`, n]));
    for (const p of pods) for (const c of p.res.pvcs ?? []) {
      const v = pvcByName.get(`${p.res.namespace}/${c}`);
      if (v) { push(r.podPvcs, p.id, v.id); push(r.pvcPods, v.id, p.id); }
    }
    for (const i of all) if (i.res.kind === 'Ingress') {
      const names = new Set((i.res.rules ?? []).map(x => x.service).filter(Boolean));
      for (const s of svcNodes) if (s.res.namespace === i.res.namespace && names.has(s.res.name)) { push(r.ingSvcs, i.id, s.id); push(r.svcIngs, s.id, i.id); }
    }
    const byNs = new Map<string, GNode[]>();
    for (const n of all) if (n.res.namespace && n.res.kind !== 'Node') {
      const l = byNs.get(n.res.namespace);
      if (l) l.push(n); else byNs.set(n.res.namespace, [n]);
    }
    this.groups = [
      ...deps.filter(d => r.depPods.has(d.id)).map(d => ({ id: d.id, kind: 'Deployment' as const, members: [d, ...r.depPods.get(d.id)!.map(id => this.nodes.get(id)!)] })),
      ...[...nsByName.values()].map(ns => ({ id: ns.id, kind: 'Namespace' as const, members: [ns, ...(byNs.get(ns.res.name) ?? [])] })),
    ];
    for (const p of pods) {
      // Pod → Node: in der Node-Ansicht die tragende Kraft, sonst nur Linie beim Hover (ohne Kraft)
      const h = hosts.get(p.res.nodeName ?? '');
      if (h) links.push({ source: p, target: h, kind: 'host', dist: 16, str: byNode ? 0.7 : 0 });
    }
    for (const n of all) {
      if (byNode) break; // Node-Ansicht: Namespaces/Deployments/Services ausgeblendet, keine Baum-Kräfte
      if (n.res.kind === 'Namespace' || n.res.kind === 'Node') continue;
      const ns = nsByName.get(n.res.namespace ?? '');
      if (n.res.kind === 'Pod') {
        const dep = deps.find(d => d.res.namespace === n.res.namespace && matches(d.res.selector, n.res.labels));
        if (dep) links.push({ source: n, target: dep, kind: 'tree', dist: 6, str: 0.8 });
        else if (ns) links.push({ source: n, target: ns, kind: 'tree', dist: 22, str: 0.5 });
      } else if (ns) {
        const k = n.res.kind;
        // PVC mit Pods hängt an den Pods (vol-Link), zur Galaxie nur schwach
        const pvcUsed = k === 'PVC' && r.pvcPods.has(n.id);
        links.push({ source: n, target: ns, kind: 'tree', dist: k === 'Service' ? 34 : k === 'Ingress' ? 48 : k === 'PVC' ? 30 : 24, str: k === 'Ingress' ? 0.3 : pvcUsed ? 0.05 : 0.6 });
      }
      if (n.res.kind === 'Pod')
        for (const v of r.podPvcs.get(n.id) ?? []) links.push({ source: n, target: this.nodes.get(v)!, kind: 'vol', dist: 7, str: 0.5 });
      if (n.res.kind === 'Ingress') {
        const svcs = new Set((n.res.rules ?? []).map(r => r.service).filter(Boolean));
        for (const t of all)
          if (t.res.kind === 'Service' && t.res.namespace === n.res.namespace && svcs.has(t.res.name))
            links.push({ source: n, target: t, kind: 'ing', dist: 16, str: 0.3 });
      }
      if (n.res.kind === 'Service') {
        for (const p of pods)
          if (p.res.namespace === n.res.namespace && matches(n.res.selector, p.res.labels))
            links.push({ source: n, target: p, kind: 'svc', dist: 18, str: 0.05 });
      }
    }
    this.links = links;
    this.sim.nodes(all);
    this.sim.force('link').links(links);
    this.sim.force('charge').strength((n: GNode) => this.charge(n));
    for (const f of ['x', 'y', 'z']) this.sim.force(f).strength((n: GNode) => this.center(n));
    this.sim.alpha(Math.max(this.sim.alpha(), 0.4));
    this.placeSuns();
    this.notify();
  }

  private notify() { this.listeners.forEach(l => l()); }
}

/** Pod eines Ingress-Controllers (Traefik, ingress-nginx, HAProxy …) – erkannt an üblichen Labels. */
export function isIngressController(r: Res) {
  const l = r.labels ?? {};
  const name = `${l['app.kubernetes.io/name'] ?? ''} ${l.app ?? ''} ${l['app.kubernetes.io/component'] ?? ''}`.toLowerCase();
  return /traefik|ingress-nginx|nginx-ingress|haproxy-ingress|contour|kong/.test(name) || l['kube-cosmos.io/access-log'] === 'traefik';
}
