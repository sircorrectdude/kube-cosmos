// Optionale Prometheus-Integration: CPU/RAM je Pod (cAdvisor + kube-state-metrics) und Last je Node (node-exporter).
// Ohne PROMETHEUS_URL inaktiv; Fehler werden geloggt, die App läuft weiter.
import { config } from './config.js';
import type { ClusterState } from './k8s.js';
import { setStatus } from './status.js';

export interface PodMetrics {
  cpu: number;          // Kerne
  cpuRel?: number;      // Anteil am CPU-Limit (sonst Request), 0..1+
  mem: number;          // Bytes (working set)
  memRel?: number;      // Anteil am Memory-Limit, 0..1+
}
export interface NodeMetrics { cpu: number; mem: number } // jeweils 0..1
export interface VolumeMetrics { used: number; capacity: number } // Bytes (kubelet_volume_stats, nicht jeder Provisioner liefert sie)

const C = 'container!="",container!="POD"';
const Q = {
  cpu: `sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{${C}}[1m]))`,
  mem: `sum by (namespace, pod) (container_memory_working_set_bytes{${C}})`,
  cpuLimit: 'sum by (namespace, pod) (kube_pod_container_resource_limits{resource="cpu"})',
  cpuReq: 'sum by (namespace, pod) (kube_pod_container_resource_requests{resource="cpu"})',
  memLimit: 'sum by (namespace, pod) (kube_pod_container_resource_limits{resource="memory"})',
  nodeCpu: '(1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[1m]))) * on (instance) group_left (nodename) node_uname_info',
  nodeMem: '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * on (instance) group_left (nodename) node_uname_info',
  volUsed: 'max by (namespace, persistentvolumeclaim) (kubelet_volume_stats_used_bytes)',
  volCap: 'max by (namespace, persistentvolumeclaim) (kubelet_volume_stats_capacity_bytes)',
};

type Sample = { metric: Record<string, string>; value: [number, string] };

export class PrometheusMetrics {
  pods: Record<string, PodMetrics> = {};   // Pod-UID → Werte
  nodes: Record<string, NodeMetrics> = {}; // Node-Name → Werte
  volumes: Record<string, VolumeMetrics> = {}; // PVC-UID → Füllstand
  private lastWarn = 0;
  private timer?: NodeJS.Timeout;

  constructor(private state: ClusterState, private onUpdate: () => void) {}

  get enabled() { return !!config.prometheusUrl; }

  start() {
    if (!this.enabled) { setStatus('prometheus', 'Prometheus', 'off', 'nicht konfiguriert (PROMETHEUS_URL)'); return; }
    setStatus('prometheus', 'Prometheus', 'unknown', `${config.prometheusUrl} · verbinde …`);
    console.log(`[metrics] Prometheus: ${config.prometheusUrl} (alle ${config.metricsIntervalMs / 1000}s)`);
    const tick = () => this.poll().catch(e => this.warn(e));
    tick();
    this.timer = setInterval(tick, config.metricsIntervalMs);
  }

  stop() { clearInterval(this.timer); }

  private warn(e: any) {
    setStatus('prometheus', 'Prometheus', 'error', `${config.prometheusUrl} · ${String(e?.message ?? e).slice(0, 100)}`);
    if (Date.now() - this.lastWarn > 60_000) console.warn(`[metrics] Prometheus nicht erreichbar: ${e?.message ?? e} – läuft ohne Metriken weiter`);
    this.lastWarn = Date.now();
  }

  private async query(q: string): Promise<Sample[]> {
    const r = await fetch(`${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(q)}`, {
      headers: config.prometheusToken ? { Authorization: `Bearer ${config.prometheusToken}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { data?: { result?: Sample[] } };
    return j.data?.result ?? [];
  }

  private async poll() {
    let firstErr: unknown;
    const [cpu, mem, cpuLimit, cpuReq, memLimit, nodeCpu, nodeMem, volUsed, volCap] = await Promise.all(
      [Q.cpu, Q.mem, Q.cpuLimit, Q.cpuReq, Q.memLimit, Q.nodeCpu, Q.nodeMem, Q.volUsed, Q.volCap]
        .map(q => this.query(q).catch(e => { firstErr ??= e; return [] as Sample[]; })));
    if (!cpu.length && !mem.length && !nodeCpu.length)
      throw firstErr ?? new Error('keine Daten (cAdvisor/node-exporter fehlen?)');

    // namespace/pod → UID
    const uid = new Map<string, string>();
    for (const r of this.state.resources.values()) if (r.kind === 'Pod') uid.set(`${r.namespace}/${r.name}`, r.uid);
    const byPod = (s: Sample[]) => {
      const m = new Map<string, number>();
      for (const x of s) { const id = uid.get(`${x.metric.namespace}/${x.metric.pod}`); if (id) m.set(id, Number(x.value[1])); }
      return m;
    };
    const [c, mm, cl, cr, ml] = [cpu, mem, cpuLimit, cpuReq, memLimit].map(byPod);

    const pods: Record<string, PodMetrics> = {};
    for (const id of new Set([...c.keys(), ...mm.keys()])) {
      const cores = c.get(id) ?? 0, bytes = mm.get(id) ?? 0;
      const cpuRef = cl.get(id) || cr.get(id);
      pods[id] = {
        cpu: round(cores, 4), mem: Math.round(bytes),
        cpuRel: cpuRef ? round(cores / cpuRef, 3) : undefined,
        memRel: ml.get(id) ? round(bytes / ml.get(id)!, 3) : undefined,
      };
    }
    const nodes: Record<string, NodeMetrics> = {};
    for (const x of nodeCpu) if (x.metric.nodename) (nodes[x.metric.nodename] ??= { cpu: 0, mem: 0 }).cpu = round(Number(x.value[1]), 3);
    for (const x of nodeMem) if (x.metric.nodename) (nodes[x.metric.nodename] ??= { cpu: 0, mem: 0 }).mem = round(Number(x.value[1]), 3);

    // namespace/pvc → UID
    const pvc = new Map<string, string>();
    for (const r of this.state.resources.values()) if (r.kind === 'PVC') pvc.set(`${r.namespace}/${r.name}`, r.uid);
    const volumes: Record<string, VolumeMetrics> = {};
    for (const [list, key] of [[volUsed, 'used'], [volCap, 'capacity']] as const)
      for (const x of list) {
        const id = pvc.get(`${x.metric.namespace}/${x.metric.persistentvolumeclaim}`);
        if (id) (volumes[id] ??= { used: 0, capacity: 0 })[key] = Number(x.value[1]);
      }

    this.pods = pods;
    this.nodes = nodes;
    this.volumes = volumes;
    const n = Object.keys(pods).length;
    setStatus('prometheus', 'Prometheus', n ? 'ok' : 'warn',
      `${config.prometheusUrl} · ${n} Pods, ${Object.keys(nodes).length} Nodes${Object.keys(volumes).length ? `, ${Object.keys(volumes).length} Volumes` : ''}`);
    this.onUpdate();
  }
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
