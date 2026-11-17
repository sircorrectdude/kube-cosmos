import * as k8s from '@kubernetes/client-node';
import { config } from './config.js';
import { setStatus } from './status.js';

export type Kind = 'Namespace' | 'Node' | 'Pod' | 'Deployment' | 'Service' | 'HPA' | 'Ingress' | 'PVC';

/** Schlanke Ressource fürs Frontend. Bewusst ohne Spec/Env, damit nie Secret-Inhalte gestreamt werden. */
export interface Res {
  uid: string;
  kind: Kind;
  name: string;
  namespace?: string;
  status?: string;
  labels?: Record<string, string>;
  nodeName?: string;
  podIP?: string;
  hostNetwork?: boolean;
  selector?: Record<string, string>;
  replicas?: number;
  readyReplicas?: number;
  restarts?: number;
  probes?: Record<string, 'ok' | 'wait' | 'fail'>;
  /** Node: cordon (unschedulable), Kapazität */
  unschedulable?: boolean;
  cpuCores?: number;
  memGi?: number;
  /** HPA: Ziel-Deployment und Replica-Spanne */
  target?: string;
  minReplicas?: number;
  maxReplicas?: number;
  currentReplicas?: number;
  desiredReplicas?: number;
  /** Ingress: Regeln Host/Pfad → Service:Port, Ingress-Klasse */
  rules?: { host?: string; path?: string; service?: string; port?: string | number }[];
  ingressClass?: string;
  /** Pod: genutzte PVCs (claimName); PVC: Speicherklasse, Größe, Zugriffsmodi, gebundenes PV */
  pvcs?: string[];
  storageClass?: string;
  capacity?: string;
  accessModes?: string[];
  volumeName?: string;
}

export interface KEvent {
  uid: string;
  namespace?: string;
  type?: string;
  reason?: string;
  message?: string;
  object?: string;
  time?: string;
}

export type Delta =
  | { type: 'upsert'; res: Res }
  | { type: 'delete'; uid: string; kind: Kind }
  | { type: 'event'; event: KEvent };

function podStatus(p: k8s.V1Pod): string {
  if (p.metadata?.deletionTimestamp) return 'Terminating';
  const cs = p.status?.containerStatuses ?? [];
  for (const c of cs) {
    const r = c.state?.waiting?.reason;
    if (r) return r; // CrashLoopBackOff, ImagePullBackOff, ContainerCreating ...
  }
  // Container mit Fehler beendet (z.B. Error, OOMKilled) – vor "Starting"/"Unready" prüfen
  const term = cs.find(c => c.state?.terminated && c.state.terminated.exitCode !== 0);
  if (term) return term.state!.terminated!.reason || 'Error';
  if (p.status?.phase === 'Running') {
    if (cs.some(c => c.started === false)) return 'Starting'; // Startup-Probe noch nicht erfolgreich
    if (cs.some(c => !c.ready)) return 'Unready';             // Readiness-Probe schlägt fehl
  }
  return p.status?.phase ?? 'Unknown';
}

type ProbeState = 'ok' | 'wait' | 'fail';
/** Zustand der konfigurierten Probes, aggregiert über alle Container. */
function probes(p: k8s.V1Pod): Record<string, ProbeState> | undefined {
  const specs = p.spec?.containers ?? [];
  const cs = p.status?.containerStatuses ?? [];
  const running = cs.length > 0 && cs.every(c => c.state?.running);
  const started = running && cs.every(c => c.started !== false);
  const out: Record<string, ProbeState> = {};
  if (specs.some(c => c.startupProbe)) out.startup = started ? 'ok' : 'wait';
  if (specs.some(c => c.readinessProbe)) out.readiness = !started ? 'wait' : cs.every(c => c.ready) ? 'ok' : 'fail';
  if (specs.some(c => c.livenessProbe)) {
    const killed = cs.some(c => c.lastState?.terminated && c.restartCount > 0);
    out.liveness = !started ? 'wait' : killed ? 'fail' : 'ok';
  }
  return Object.keys(out).length ? out : undefined;
}

const mappers: Record<Kind, (o: any) => Res> = {
  Namespace: (o: k8s.V1Namespace) => base(o, 'Namespace', { status: o.status?.phase }),
  Node: (o: k8s.V1Node) => base(o, 'Node', {
    status: o.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady',
    unschedulable: o.spec?.unschedulable || undefined,
    cpuCores: cpuQty(o.status?.capacity?.cpu),
    memGi: memQty(o.status?.capacity?.memory),
  }),
  Ingress: (o: k8s.V1Ingress) => {
    const rules: NonNullable<Res['rules']> = [];
    const def = o.spec?.defaultBackend?.service;
    if (def) rules.push({ path: '*', service: def.name, port: def.port?.number ?? def.port?.name });
    for (const r of o.spec?.rules ?? [])
      for (const p of r.http?.paths ?? [])
        rules.push({ host: r.host, path: p.path ?? '/', service: p.backend.service?.name, port: p.backend.service?.port?.number ?? p.backend.service?.port?.name });
    return base(o, 'Ingress', {
      rules, ingressClass: o.spec?.ingressClassName,
      status: o.status?.loadBalancer?.ingress?.length ? 'Active' : 'Pending',
    });
  },
  HPA: (o: k8s.V2HorizontalPodAutoscaler) => {
    const cur = o.status?.currentReplicas ?? 0, want = o.status?.desiredReplicas ?? cur, max = o.spec?.maxReplicas ?? 1;
    return base(o, 'HPA', {
      target: o.spec?.scaleTargetRef?.kind === 'Deployment' ? o.spec.scaleTargetRef.name : undefined,
      minReplicas: o.spec?.minReplicas ?? 1, maxReplicas: max, currentReplicas: cur, desiredReplicas: want,
      status: want !== cur ? 'Scaling' : cur >= max ? 'AtMax' : 'Stable',
    });
  },
  Pod: (o: k8s.V1Pod) => base(o, 'Pod', {
    status: podStatus(o),
    nodeName: o.spec?.nodeName,
    podIP: o.status?.podIP,
    hostNetwork: o.spec?.hostNetwork || undefined, // Pod-IP = Node-IP → nicht für IP-Zuordnung nutzbar
    restarts: (o.status?.containerStatuses ?? []).reduce((s, c) => s + c.restartCount, 0),
    probes: probes(o),
    pvcs: (() => { const c = (o.spec?.volumes ?? []).map(v => v.persistentVolumeClaim?.claimName).filter((x): x is string => !!x); return c.length ? c : undefined; })(),
  }),
  PVC: (o: k8s.V1PersistentVolumeClaim) => base(o, 'PVC', {
    status: o.metadata?.deletionTimestamp ? 'Terminating' : o.status?.phase ?? 'Pending', // Bound | Pending | Lost
    storageClass: o.spec?.storageClassName,
    capacity: o.status?.capacity?.storage ?? o.spec?.resources?.requests?.storage,
    accessModes: o.spec?.accessModes,
    volumeName: o.spec?.volumeName,
  }),
  Deployment: (o: k8s.V1Deployment) => base(o, 'Deployment', {
    selector: o.spec?.selector?.matchLabels,
    replicas: o.spec?.replicas ?? 0,
    readyReplicas: o.status?.readyReplicas ?? 0,
    status: (o.status?.readyReplicas ?? 0) >= (o.spec?.replicas ?? 0) ? 'Available' : 'Progressing',
  }),
  Service: (o: k8s.V1Service) => base(o, 'Service', { selector: o.spec?.selector, status: o.spec?.type }),
};

/** "4" / "3500m" → Kerne */
function cpuQty(q?: string) {
  if (!q) return undefined;
  return q.endsWith('m') ? Number(q.slice(0, -1)) / 1000 : Number(q);
}
/** "16Gi" / "16374628Ki" / "512Mi" → GiB */
function memQty(q?: string) {
  const m = q && /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?$/.exec(q);
  if (!m) return undefined;
  const f = { Ki: 1 / 1048576, Mi: 1 / 1024, Gi: 1, Ti: 1024 }[m[2] as 'Ki'] ?? 1 / 1073741824;
  return Math.round(Number(m[1]) * f * 10) / 10;
}

function base(o: k8s.KubernetesObject, kind: Kind, extra: Partial<Res>): Res {
  return {
    uid: o.metadata!.uid!,
    kind,
    name: o.metadata!.name!,
    namespace: o.metadata?.namespace,
    labels: o.metadata?.labels,
    ...extra,
  };
}

function nsAllowed(ns?: string) {
  return !config.namespaces.length || !ns || config.namespaces.includes(ns);
}

export function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (config.k8sAuth === 'incluster') kc.loadFromCluster();
  else {
    kc.loadFromDefault();
    if (kc.getContexts().some(c => c.name === config.kubeContext)) kc.setCurrentContext(config.kubeContext);
  }
  return kc;
}

/** Hält den Cluster-Zustand per Informer (List+Watch, Reconnect/Resync) und meldet Deltas. */
export class ClusterState {
  resources = new Map<string, Res>();
  events: KEvent[] = [];
  private listeners = new Set<(d: Delta) => void>();

  constructor(readonly kc: k8s.KubeConfig) {}

  onDelta(fn: (d: Delta) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(d: Delta) { for (const l of this.listeners) l(d); }

  /** Kurzer Problemstatus (für KI-Antworten): Pods mit Fehlerstatus/vielen Restarts, Deployments mit fehlenden Replicas. */
  /** Aktuelle Probleme (Pods mit Fehler-/Wartestatus, Deployments mit fehlenden Replicas) + früher neu gestartete Pods. */
  problems() {
    const ok = new Set(['Running', 'Succeeded', 'Completed', 'Active', 'Available']);
    const issues: { kind: string; ns?: string; name: string; what: string }[] = [];
    const restarted: Res[] = [];
    for (const r of this.resources.values()) {
      if (r.kind === 'Pod' && !ok.has(r.status ?? '')) issues.push({ kind: 'Pod', ns: r.namespace, name: r.name, what: r.status ?? 'unbekannt' });
      else if (r.kind === 'Pod' && (r.restarts ?? 0) >= 3) restarted.push(r);
      if (r.kind === 'Deployment' && (r.readyReplicas ?? 0) < (r.replicas ?? 0))
        issues.push({ kind: 'Deployment', ns: r.namespace, name: r.name, what: `nur ${r.readyReplicas ?? 0} von ${r.replicas} bereit` });
    }
    return { issues, restarted };
  }

  /** Problemstatus als Kontext für KI-Antworten. */
  problemSummary() {
    const { issues, restarted } = this.problems();
    const hist = restarted.length
      ? `\nHinweis (kein aktueller Fehler): ${restarted.length} Pods wurden früher neu gestartet, laufen jetzt aber normal, z.B. ${restarted.slice(0, 3).map(r => `${r.name} (${r.restarts}×)`).join(', ')}.`
      : '';
    if (!issues.length) return 'AKTUELL KEINE PROBLEME: alle Pods laufen bzw. sind fertig, alle Deployments vollständig bereit.' + hist;
    return `${issues.length} AKTUELLE PROBLEME:\n` + issues.slice(0, 15).map(i => `${i.kind} ${i.ns}/${i.name}: ${i.what}`).join('\n')
      + (issues.length > 15 ? `\n… und ${issues.length - 15} weitere` : '') + hist;
  }

  has(kind: string, ns: string | undefined, name: string) {
    for (const r of this.resources.values()) if (r.kind === kind && r.name === name && (r.kind === 'Namespace' || r.namespace === ns)) return true;
    return false;
  }

  /** Kontext fürs Sprachmodell: Namespaces, Deployments (Namespace/Name, Replicas), Services. Reine Daten. */
  contextSummary() {
    const all = [...this.resources.values()];
    const ns = all.filter(r => r.kind === 'Namespace').map(r => r.name);
    const deps = all.filter(r => r.kind === 'Deployment').map(r => `${r.namespace}/${r.name} (${r.readyReplicas ?? 0}/${r.replicas} bereit)`);
    const svcs = all.filter(r => r.kind === 'Service').map(r => `${r.namespace}/${r.name}`);
    const pods = all.filter(r => r.kind === 'Pod').length;
    return `Namespaces: ${ns.join(', ')}\nDeployments: ${deps.join(', ')}\nServices: ${svcs.join(', ')}\nPods insgesamt: ${pods}`;
  }

  snapshot() {
    return { resources: [...this.resources.values()], events: this.events };
  }

  /** Watch-Zustand je Ressourcenart (für den Status) */
  private watches = new Map<string, string | null>(); // Name → Fehlertext oder null = ok
  private apiVersion = '';
  private apiError = '';
  private reportStatus() {
    const all = [...this.watches.values()];
    const bad = all.filter(Boolean) as string[];
    const ctx = config.k8sAuth === 'incluster' ? 'in-cluster' : this.kc.getCurrentContext();
    const base = `${ctx}${this.apiVersion ? ' · ' + this.apiVersion : ''}`;
    if (this.apiError) setStatus('k8s', 'Kubernetes', 'error', `${ctx} · ${this.apiError}`);
    else if (bad.length) setStatus('k8s', 'Kubernetes', bad.length === all.length ? 'error' : 'warn', `${base} · ${bad.length}/${all.length} Watches gestört: ${bad[0]}`);
    else if (all.length) setStatus('k8s', 'Kubernetes', 'ok', `${base} · ${all.length} Watches`);
    else setStatus('k8s', 'Kubernetes', 'unknown', `${base} · verbinde …`);
  }
  /** API-Server erreichbar? Alle 15 s Version abfragen. */
  private async ping() {
    try {
      const v = await this.kc.makeApiClient(k8s.VersionApi).getCode();
      this.apiVersion = v.gitVersion; this.apiError = '';
    } catch (e: any) { this.apiError = String(e?.message ?? e).slice(0, 120); }
    this.reportStatus();
  }

  async start() {
    this.reportStatus();
    this.ping();
    setInterval(() => this.ping(), 15_000).unref();
    const core = this.kc.makeApiClient(k8s.CoreV1Api);
    const apps = this.kc.makeApiClient(k8s.AppsV1Api);
    // TODO production: bei gesetzten NAMESPACES pro Namespace watchen (RBAC), statt clientseitig zu filtern.
    this.watch('Namespace', '/api/v1/namespaces', () => core.listNamespace());
    this.watch('Node', '/api/v1/nodes', () => core.listNode());
    this.watch('Pod', '/api/v1/pods', () => core.listPodForAllNamespaces());
    this.watch('Deployment', '/apis/apps/v1/deployments', () => apps.listDeploymentForAllNamespaces());
    this.watch('Service', '/api/v1/services', () => core.listServiceForAllNamespaces());
    this.watch('PVC', '/api/v1/persistentvolumeclaims', () => core.listPersistentVolumeClaimForAllNamespaces());
    const net = this.kc.makeApiClient(k8s.NetworkingV1Api);
    this.watch('Ingress', '/apis/networking.k8s.io/v1/ingresses', () => net.listIngressForAllNamespaces());
    const hpa = this.kc.makeApiClient(k8s.AutoscalingV2Api);
    this.watch('HPA', '/apis/autoscaling/v2/horizontalpodautoscalers', () => hpa.listHorizontalPodAutoscalerForAllNamespaces());
    this.watchEvents(core);
  }

  private watch(kind: Kind, path: string, list: () => Promise<any>) {
    const inf = k8s.makeInformer(this.kc, path, list);
    const up = (o: k8s.KubernetesObject) => {
      if (kind !== 'Namespace' && !nsAllowed(o.metadata?.namespace)) return;
      if (kind === 'Namespace' && !nsAllowed(o.metadata?.name)) return;
      const res = mappers[kind](o);
      this.resources.set(res.uid, res);
      this.emit({ type: 'upsert', res });
    };
    inf.on('add', up);
    inf.on('update', up);
    inf.on('delete', (o: k8s.KubernetesObject) => {
      const uid = o.metadata?.uid;
      if (uid && this.resources.delete(uid)) this.emit({ type: 'delete', uid, kind });
    });
    this.keepAlive(inf, kind);
  }

  private watchEvents(core: k8s.CoreV1Api) {
    const inf = k8s.makeInformer(this.kc, '/api/v1/events', () => core.listEventForAllNamespaces());
    const on = (e: k8s.CoreV1Event) => {
      if (!nsAllowed(e.metadata?.namespace)) return;
      const ev: KEvent = {
        uid: e.metadata!.uid!,
        namespace: e.metadata?.namespace,
        type: e.type,
        reason: e.reason,
        message: e.message,
        object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
        time: String(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? ''),
      };
      this.events.push(ev);
      if (this.events.length > 200) this.events.shift();
      this.emit({ type: 'event', event: ev });
    };
    inf.on('add', on);
    inf.on('update', on);
    this.keepAlive(inf, 'Event');
  }

  /** Bei Fehler/Abbruch nach 5s neu starten; Informer listet neu und gleicht Zustand ab (Resync). */
  private keepAlive(inf: k8s.Informer<any>, name: string) {
    const fail = (err: any) => { this.watches.set(name, `${name}: ${String(err?.message ?? err).slice(0, 80)}`); this.reportStatus(); };
    const ok = () => { this.watches.set(name, null); this.reportStatus(); };
    inf.on('error', (err: any) => {
      console.warn(`[watch ${name}] Fehler: ${err?.message ?? err} – Reconnect in 5s`);
      fail(err);
      setTimeout(() => inf.start().then(ok).catch(() => {}), 5000);
    });
    inf.start().then(ok).catch(err => {
      console.warn(`[watch ${name}] Start fehlgeschlagen: ${err?.message ?? err} – Retry in 5s`);
      fail(err);
      setTimeout(() => this.keepAlive(inf, name), 5000);
    });
  }
}
