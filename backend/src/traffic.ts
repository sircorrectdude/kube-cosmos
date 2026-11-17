// Austauschbare Traffic-Quelle. Standard: none. mock = simulierte Requests entlang der Services.
// Später: hubble = Cilium Hubble Relay per gRPC (optional, ohne Cilium läuft alles weiter).
import type { ClusterState, Res } from './k8s.js';
import { LogTrafficSource } from './trafficLogs.js';

export interface Flow {
  src: string; // Pod-UID oder "ext:<entry>|<agent>" (außerhalb des Clusters)
  dst: string;
  type: 'request' | 'response';
  verdict: 'forwarded' | 'dropped' | 'error';
  protocol?: string;
  httpMethod?: string;
  httpStatus?: number;
  /** nur bei externen Flows: Eintrittspunkt (Traefik-Router oder Ziel-App), Client-Typ, Client-IP, Pfad */
  ext?: { entry: string; agent: string; ip: string; path: string };
}

export interface TrafficSource {
  readonly name: string;
  /** Kurzinfo für den Status (z.B. Anzahl gelesener Log-Streams) */
  info?(): string;
  start(onFlow: (f: Flow) => void): void;
  stop(): void;
}

export class NullTrafficSource implements TrafficSource {
  readonly name = 'none';
  start() {}
  stop() {}
}

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const METHODS = ['GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE'];
const matches = (sel: Record<string, string> | undefined, labels: Record<string, string> | undefined) =>
  !!sel && Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels?.[k] === v);

/** Simuliert HTTP-Traffic: Client-Pod → Service-Backend-Pod und zurück. Fehler häufen sich bei kranken Pods. */
export class MockTrafficSource implements TrafficSource {
  readonly name = 'mock';
  private timer?: NodeJS.Timeout;
  constructor(private state: ClusterState, private ratePerSec = 25) {}

  start(onFlow: (f: Flow) => void) {
    this.timer = setInterval(() => {
      const n = Math.max(1, Math.round((this.ratePerSec / 10) * (0.5 + Math.random())));
      for (let i = 0; i < n; i++) this.emitOne(onFlow);
    }, 100);
  }

  stop() { clearInterval(this.timer); }

  private emitOne(onFlow: (f: Flow) => void) {
    const all = [...this.state.resources.values()];
    const pods = all.filter(r => r.kind === 'Pod' && !['Succeeded', 'Completed', 'Terminating'].includes(r.status ?? ''));
    // Ziele: Pods hinter Services; sonst (keine Services) beliebige Pods im selben Namespace.
    const svcs = all.filter(r => r.kind === 'Service' && r.selector && r.namespace !== 'kube-system');
    const targets: [Res, Res[]][] = svcs
      .map(s => [s, pods.filter(p => p.namespace === s.namespace && matches(s.selector, p.labels))] as [Res, Res[]])
      .filter(([, b]) => b.length);
    let dst: Res | undefined, clients: Res[];
    if (targets.length && Math.random() < 0.8) {
      const [svc, backends] = pick(targets);
      dst = pick(backends);
      const ingress = pods.filter(p => p.namespace === 'traefik' || p.labels?.['app.kubernetes.io/name'] === 'traefik');
      clients = Math.random() < 0.3 && ingress.length ? ingress : pods.filter(p => p.namespace === svc.namespace && !backends.includes(p));
    } else {
      dst = pick(pods);
      clients = pods.filter(p => dst && p.namespace === dst.namespace && p !== dst);
    }
    if (!dst || !clients.length) return;
    const src = pick(clients);

    const healthy = dst.status === 'Running';
    const r = Math.random();
    const verdict: Flow['verdict'] = healthy ? (r < 0.02 ? 'dropped' : r < 0.07 ? 'error' : 'forwarded')
      : (r < 0.5 ? 'dropped' : 'error');
    const method = pick(METHODS);
    onFlow({ src: src.uid, dst: dst.uid, type: 'request', verdict: verdict === 'dropped' ? 'dropped' : 'forwarded', protocol: 'HTTP', httpMethod: method });
    if (verdict === 'dropped') return;
    const status = verdict === 'error' ? pick([500, 502, 503, 504]) : pick([200, 200, 200, 201, 204, 304]);
    setTimeout(() => onFlow({ src: dst!.uid, dst: src.uid, type: 'response', verdict, protocol: 'HTTP', httpMethod: method, httpStatus: status }),
      150 + Math.random() * 400);
  }
}

export function createTrafficSource(kind: string, state: ClusterState): TrafficSource {
  if (kind === 'mock') return new MockTrafficSource(state);
  if (kind === 'logs') return new LogTrafficSource(state);
  if (kind === 'hubble') console.warn('[traffic] hubble ist noch nicht implementiert – verwende none');
  return new NullTrafficSource();
}
