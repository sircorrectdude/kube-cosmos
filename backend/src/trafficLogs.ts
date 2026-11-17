// Echte Traffic-Daten ohne Service-Mesh/Cilium: Access-Logs markierter Pods über die Kubernetes-Log-API mitlesen.
// Client-IP (Pod-IP bleibt bei Pod→Service-Verkehr erhalten) → Quell-Pod, loggender Pod → Ziel-Pod.
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'node:stream';
import { config } from './config.js';
import type { ClusterState, Res } from './k8s.js';
import type { Flow, TrafficSource } from './traffic.js';

// CLF/combined (nginx, traefik): 10.244.1.5 - - [11/Nov/2026:12:00:00 +0000] "GET /api/ HTTP/1.1" 200 15 "-" "Wget" ...
// Traefik hängt an: <Anzahl> "<router@provider>" "<backend-url>" <dauer>ms
const LINE = /^(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+) \S+ \S+ \[[^\]]+\] "(\S+) (\S*)[^"]*" (\d{3}) \S+(?: "[^"]*" "([^"]*)")?(?: \d+ "([^"]*)"(?: "([^"]*)")?)?/;

/** Client-Typ aus dem User-Agent. */
export function agentClass(ua = '') {
  const u = ua.toLowerCase();
  if (!u || u === '-') return 'unbekannt';
  if (/bot|crawl|spider|slurp/.test(u)) return 'Bot';
  if (/blackbox|prometheus|uptime|pingdom|health|monitor/.test(u)) return 'Monitoring';
  if (/curl|wget|python|go-http|node|undici|axios|okhttp|apachebench|^ab\/|k6|hey|java|powershell/.test(u)) return 'Skript';
  if (/mozilla|chrome|safari|firefox|edg\//.test(u)) return 'Browser';
  return 'unbekannt';
}

export class LogTrafficSource implements TrafficSource {
  readonly name = 'logs';
  private streams = new Map<string, AbortController>(); // Pod-UID → Stream
  private timer?: NodeJS.Timeout;
  private budget = 0;
  private dropped = 0;
  private sel: [string, string | undefined];

  constructor(private state: ClusterState) {
    const [k, v] = config.logSelector.split('=');
    this.sel = [k.trim(), v?.trim()];
  }

  private selected(r: Res) {
    const val = r.labels?.[this.sel[0]];
    return val !== undefined && (this.sel[1] === undefined || val === this.sel[1]);
  }

  start(onFlow: (f: Flow) => void) {
    const log = new k8s.Log(this.state.kc);
    const reconcile = () => {
      const want = new Map<string, Res>();
      for (const r of this.state.resources.values())
        if (r.kind === 'Pod' && r.status === 'Running' && this.selected(r)) want.set(r.uid, r);
      for (const [uid, ac] of this.streams) if (!want.has(uid)) { ac.abort(); this.streams.delete(uid); }
      for (const [uid, pod] of want) if (!this.streams.has(uid)) this.follow(log, pod, onFlow);
      // Budget für Sampling: max. maxFlowsPerSec Request/Response-Paare
      if (this.dropped) console.log(`[traffic logs] ${this.dropped} Zeilen wegen Ratenlimit verworfen`);
      this.dropped = 0;
    };
    reconcile();
    this.timer = setInterval(reconcile, 5000);
    setInterval(() => { this.budget = config.maxFlowsPerSec; }, 1000).unref();
    this.budget = config.maxFlowsPerSec;
  }

  info() { return `${this.streams.size} Log-Streams (${config.logSelector})`; }

  stop() {
    clearInterval(this.timer);
    for (const ac of this.streams.values()) ac.abort();
    this.streams.clear();
  }

  private follow(log: k8s.Log, pod: Res, onFlow: (f: Flow) => void) {
    const ac = new AbortController();
    this.streams.set(pod.uid, ac);
    const out = new PassThrough();
    let rest = '';
    out.on('data', (chunk: Buffer) => {
      const lines = (rest + chunk.toString()).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) this.parse(l, pod, onFlow);
    });
    const end = () => { if (this.streams.get(pod.uid) === ac) this.streams.delete(pod.uid); }; // nächster reconcile startet neu
    out.on('end', end);
    out.on('error', end);
    log.log(pod.namespace!, pod.name, '', out, { follow: true, sinceSeconds: 1 })
      .then(req => ac.signal.addEventListener('abort', () => req.abort()))
      .catch(err => { console.warn(`[traffic logs] ${pod.name}: ${err?.message ?? err}`); end(); });
  }

  private parse(line: string, dst: Res, onFlow: (f: Flow) => void) {
    const m = LINE.exec(line);
    if (!m) return;
    if (line.includes('"kube-probe/')) return; // Health-Checks des Kubelets
    if (this.budget <= 0) { this.dropped++; return; }
    // Client-IP gehört zu keinem Pod = Request von außerhalb ("external"): über den Ingress (Node-IP),
    // per kubectl port-forward (127.0.0.1), NodePort o.ä. Health-Checks sind oben bereits ausgefiltert.
    const pod = this.byIp(m[1]);
    let src = pod?.uid, ext: Flow['ext'];
    if (!src) {
      // Eintrittspunkt: Traefik-Router (ohne @provider), sonst direkt an die App (port-forward, NodePort)
      const router = m[6] && m[6] !== '-' ? m[6].replace(/@.*$/, '') : '';
      const entry = router || `direkt → ${dst.labels?.app ?? dst.name}`;
      const agent = agentClass(m[5]);
      ext = { entry, agent, ip: m[1], path: (m[3] || '/').split('?')[0].slice(0, 80) };
      src = `ext:${entry}|${agent}`;
    }
    this.budget--;
    const status = Number(m[4]);
    const method = m[2];
    onFlow({ src, dst: dst.uid, type: 'request', verdict: 'forwarded', protocol: 'HTTP', httpMethod: method, ext });
    onFlow({ src: dst.uid, dst: src, type: 'response', verdict: status >= 500 ? 'error' : 'forwarded', protocol: 'HTTP', httpMethod: method, httpStatus: status, ext });

    // Ingress-Controller (Traefik) loggt das Ziel: "http://10.244.2.18:80" → nächster Hop Controller → Backend-Pod.
    // Nur wenn das Backend selbst keine Access-Logs liefert, sonst käme der Hop doppelt.
    const up = m[7] && /^https?:\/\/\[?([0-9a-f.:]+?)\]?:\d+/i.exec(m[7]);
    const backend = up ? this.byIp(up[1]) : undefined;
    if (backend && backend.uid !== dst.uid && !this.selected(backend)) {
      onFlow({ src: dst.uid, dst: backend.uid, type: 'request', verdict: 'forwarded', protocol: 'HTTP', httpMethod: method });
      onFlow({ src: backend.uid, dst: dst.uid, type: 'response', verdict: status >= 500 ? 'error' : 'forwarded', protocol: 'HTTP', httpMethod: method, httpStatus: status });
    }
  }

  private ipCache = new Map<string, Res>();
  private cacheAt = 0;
  private byIp(ip: string) {
    if (Date.now() - this.cacheAt > 2000) {
      this.ipCache.clear();
      for (const r of this.state.resources.values()) if (r.kind === 'Pod' && r.podIP && !r.hostNetwork) this.ipCache.set(r.podIP, r);
      this.cacheAt = Date.now();
    }
    return this.ipCache.get(ip);
  }
}
