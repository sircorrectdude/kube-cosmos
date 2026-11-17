import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config, validateConfig } from './config.js';
import { ClusterState, loadKubeConfig } from './k8s.js';
import { createTrafficSource, type Flow } from './traffic.js';
import { audit, authenticate, checkPolicy } from './security.js';
import { cancel, execute, isReadOnly, propose, proposeDirect, proposeManifest, summarize } from './command.js';
import { serveStatic } from './static.js';
import { PrometheusMetrics } from './metrics.js';
import { onStatus, setStatus, statusList } from './status.js';
import { Player, Recorder } from './recorder.js';

validateConfig();


const state = new ClusterState(loadKubeConfig());
const traffic = createTrafficSource(config.trafficSource, state);
const recorder = new Recorder(state);
const replaying = new WeakSet<object>(); // Clients im Replay bekommen keine Live-Deltas/Flows/Metriken
// optional: Prometheus-Metriken (CPU/RAM je Pod, Node-Last); ohne PROMETHEUS_URL inaktiv
const metrics = new PrometheusMetrics(state, () => {
  const m = { type: 'metrics' as const, pods: metrics.pods, nodes: metrics.nodes, volumes: metrics.volumes };
  recorder.metrics(m);
  broadcast(m, true);
});
const broadcast = (m: object, liveOnly = false) => {
  const msg = JSON.stringify(m);
  for (const c of wss.clients) if (c.readyState === c.OPEN && !(liveOnly && replaying.has(c))) c.send(msg);
};

// Konsolen-Output
state.onDelta(d => {
  if (d.type === 'upsert') console.log(`~ ${d.res.kind} ${d.res.namespace ? d.res.namespace + '/' : ''}${d.res.name} ${d.res.status ?? ''}`);
  else if (d.type === 'delete') console.log(`- ${d.kind} ${d.uid}`);
  else console.log(`! ${d.event.type} ${d.event.reason} ${d.event.object}: ${d.event.message}`);
});

const staticHandler = config.staticDir ? serveStatic(config.staticDir) : undefined;
let ready = false;
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.end('ok'); return; }                                        // Liveness
  if (req.url === '/readyz') { res.statusCode = ready ? 200 : 503; res.end(ready ? 'ok' : 'starting'); return; } // Readiness
  if (staticHandler?.(req, res)) return;
  res.statusCode = 404; res.end();
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const who = authenticate(req);
  if (!who) { ws.close(4401, 'unauthorized'); return; }
  const snapshot = () => ws.send(JSON.stringify({ type: 'snapshot', mode: config.mode, commandsEnabled: config.commandsEnabled, traffic: traffic.name,
    metrics: metrics.enabled ? { source: 'prometheus', pods: metrics.pods, nodes: metrics.nodes, volumes: metrics.volumes } : undefined,
    replay: recorder.enabled, status: statusList(), ...state.snapshot() }));
  snapshot();
  const reply = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  // Replay: eigener Player je Client; Ende/„live“ → zurück zum Live-Snapshot
  let player: Player | undefined;
  const goLive = () => { player?.stop(); player = undefined; replaying.delete(ws); if (ws.readyState === ws.OPEN) snapshot(); };
  const off = state.onDelta(d => !player && ws.readyState === ws.OPEN && ws.send(JSON.stringify(d)));
  ws.on('close', () => { off(); player?.stop(); });

  ws.on('message', async raw => {
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (typeof m.type === 'string' && m.type.startsWith('replay:')) {
      if (!recorder.enabled) return;
      if (m.type === 'replay:range') return reply({ type: 'replay:range', ...recorder.range() });
      if (m.type === 'replay:live') return goLive();
      if (m.type === 'replay:seek') {
        if (!player) { player = new Player(recorder, reply, goLive); replaying.add(ws); }
        return player.seek(Number(m.ts) || Date.now() - 600_000, !!m.play, Number(m.speed) || undefined);
      }
      if (m.type === 'replay:play') return player?.play(Number(m.speed) || 1);
      if (m.type === 'replay:pause') return player?.pause();
      return;
    }
    if (!['command', 'manifest', 'kubectl', 'confirm', 'cancel'].includes(m.type)) return;
    // rid = Anfrage-ID des Chat-Eintrags im Frontend; jede Antwort trägt sie, damit der Verlauf zugeordnet werden kann
    const rid = typeof m.rid === 'string' ? m.rid.slice(0, 64) : undefined;
    const r = (x: object) => reply({ ...x, rid });
    if (!config.commandsEnabled) return r({ type: 'commandError', error: `Befehle sind im Modus ${config.mode} deaktiviert` });
    if (player) return r({ type: 'commandError', error: 'Im Replay sind keine Befehle möglich – erst zurück zu Live' });
    const exists = state.has.bind(state);

    /** Ergebnis senden und danach (asynchron) die Antwort in Alltagssprache nachliefern. */
    const result = (id: string, res: { output: string; command: string; question?: string }) => {
      r({ type: 'commandResult', id, ok: true, output: res.output, command: res.command });
      if (!res.question) return;
      summarize( // Antwort formuliert immer das Sprachmodell
res.question, res.command, res.output, state.problemSummary())
        .then(text => text && r({ type: 'answer', text }))
        .catch(e => console.warn(`[answer] ${e?.message ?? e}`));
    };

    try {
      if (m.type === 'command' || m.type === 'manifest' || m.type === 'kubectl') {
        const text = String(m.text ?? m.yaml ?? '').slice(0, m.type === 'manifest' ? 50_000 : 500);
        const question = m.type === 'command' ? text : typeof m.question === 'string' ? m.question.slice(0, 500) : undefined;
        r({ type: 'thinking' });
        let p;
        if (m.type === 'manifest') p = proposeManifest(text, m.namespace ? String(m.namespace) : undefined, exists);
        else if (m.type === 'kubectl') p = proposeDirect(text);           // fertiger Befehl (Kontextmenü, lokal erkannte Sätze)
        else {
          // Freitext/Sprache → Ansicht + Befehl; Kontext: Namespaces, Deployments, aktueller Problemstatus
          const res = await propose(text, `${state.contextSummary()}\n${state.problemSummary()}`, exists);
          if (res.ui.length) r({ type: 'ui', actions: res.ui });
          if (!res.proposal) return r({ type: 'idle' });
          p = res.proposal;
        }
        p.question = question;
        const pol = checkPolicy(who, p.command);
        if (!pol.allowed) throw new Error(pol.reason ?? 'Policy verbietet den Befehl');
        audit({ action: 'propose', user: who.user, source: m.type, command: p.command });
        // Lesende Befehle ohne Bestätigung ausführen (Kontextmenü mit autoRun, Sprache/Text immer); alles andere wartet auf "confirm"
        if ((m.type === 'command' || (m.type === 'kubectl' && m.autoRun)) && isReadOnly(p.args) && !p.manifest) {
          const res = await execute(p.id);
          audit({ action: 'execute', user: who.user, command: res.command, auto: true });
          return result(p.id, res);
        }
        console.log(`[command] Vorschlag: ${p.command}${p.destructive ? '  (DESTRUKTIV)' : ''}`);
        r({ type: 'proposal', id: p.id, command: p.command, destructive: p.destructive, warning: p.warning, manifest: p.manifest });
      } else if (m.type === 'confirm') {
        const res = await execute(String(m.id));
        audit({ action: 'execute', user: who.user, id: m.id, command: res.command });
        console.log(`[command] ausgeführt: ${res.command}`);
        result(String(m.id), res);
      } else { cancel(String(m.id)); r({ type: 'cancelled', id: m.id }); }
    } catch (e: any) {
      r({ type: 'commandError', id: m.id, error: e.message });
    }
  });
});

// Status-Änderungen an alle Clients
onStatus(() => broadcast({ type: 'status', status: statusList() }));
// Sprachmodell: Zustand erst nach dem ersten Aufruf bekannt
if (!config.commandsEnabled) setStatus('llm', 'Sprachmodell', 'off', `Befehle im Modus ${config.mode} aus`);
else setStatus('llm', 'Sprachmodell', 'unknown', config.commandEngine === 'kubectl-ai' ? 'kubectl-ai · noch nicht genutzt' : `${config.llmModel} (${config.llmProvider}) · noch nicht genutzt`);

// Flows gebündelt alle 100 ms verschicken
let flowBuf: Flow[] = [];
let flowCount = 0;
traffic.start(f => { flowCount++; recorder.flow(f); if (flowBuf.length < 2000) flowBuf.push(f); });
// Traffic-Status alle 5 s: Quelle, Streams, Rate
const trafficStatus = () => {
  const rate = flowCount / 2 / 5; flowCount = 0; // Request+Response = 1 Anfrage
  const info = traffic.info?.() ?? '';
  if (traffic.name === 'none') setStatus('traffic', 'Traffic', 'off', 'TRAFFIC_SOURCE=none');
  else {
    // logs: ohne gelesene Streams eingeschränkt (keine markierten Pods); kein Traffic ist kein Fehler
    const streams = Number(/^(\d+) Log-Streams/.exec(info)?.[1] ?? 1);
    setStatus('traffic', 'Traffic', streams > 0 ? 'ok' : 'warn',
      `${traffic.name}${info ? ' · ' + info : ''} · ${rate > 0 ? rate.toFixed(1) + ' req/s' : 'gerade kein Traffic'}`);
  }
};
trafficStatus();
setInterval(trafficStatus, 5000).unref();
setInterval(() => {
  if (!flowBuf.length) return;
  const msg = JSON.stringify({ type: 'flows', flows: flowBuf });
  flowBuf = [];
  for (const c of wss.clients) if (c.readyState === c.OPEN && !replaying.has(c)) c.send(msg);
}, 100);

await state.start();
recorder.start();
metrics.start();
server.listen(config.port, config.host, () => {
  ready = true;
  console.log(`kube-cosmos backend [${config.mode}] auf ws://${config.host}:${config.port}/ws${staticHandler ? ` + Frontend aus ${config.staticDir}` : ''}`);
});
