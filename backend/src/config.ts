export type Mode = 'local' | 'readonly' | 'production';

const env = process.env;
const mode = (env.MODE ?? 'local') as Mode;

export const config = {
  mode,
  port: Number(env.PORT ?? 7070),
  host: mode === 'local' ? '127.0.0.1' : (env.HOST ?? '0.0.0.0'),
  k8sAuth: (env.K8S_AUTH ?? 'kubeconfig') as 'kubeconfig' | 'incluster',
  kubeContext: env.KUBE_CONTEXT ?? 'docker-desktop',
  namespaces: (env.NAMESPACES ?? '').split(',').map(s => s.trim()).filter(Boolean),
  commandsEnabled: mode !== 'readonly',
  // Replay: Aufzeichnung der Deltas (NDJSON je Stunde + Keyframes). REPLAY_DIR leer = aus
  replayDir: env.REPLAY_DIR ?? 'rec',
  replayRetentionH: Number(env.REPLAY_RETENTION_H ?? 24),
  replayKeyframeMs: Number(env.REPLAY_KEYFRAME_SEC ?? 120) * 1000,
  staticDir: env.STATIC_DIR, // gebautes Frontend (Container); leer = nur WS/API
  trafficSource: env.TRAFFIC_SOURCE ?? 'logs', // logs (echte Access-Logs) | mock | none | hubble
  // logs: Pods mit diesem Label (Schlüssel oder Schlüssel=Wert) liefern Access-Logs im CLF-Format (nginx, traefik)
  logSelector: env.LOG_SELECTOR ?? 'kube-cosmos.io/access-log',
  maxFlowsPerSec: Number(env.MAX_FLOWS_PER_SEC ?? 600),
  // Optionale Integration: Prometheus für CPU/RAM je Pod und Node-Last. Leer = aus (App läuft standalone).
  prometheusUrl: (env.PROMETHEUS_URL ?? '').replace(/\/$/, ''),
  prometheusToken: env.PROMETHEUS_TOKEN, // optional Bearer-Token (z.B. hinter Auth-Proxy)
  metricsIntervalMs: Number(env.METRICS_INTERVAL_SEC ?? 10) * 1000,
  // Sprachmodell – austauschbar nur per Konfiguration (siehe src/llm.ts)
  commandEngine: (env.COMMAND_ENGINE === 'kubectl-ai' ? 'kubectl-ai' : 'llm') as 'llm' | 'kubectl-ai',
  llmProvider: (env.LLM_PROVIDER === 'openai' ? 'openai' : 'ollama') as 'ollama' | 'openai',
  llmBaseUrl: (env.LLM_BASE_URL ?? (env.LLM_PROVIDER === 'openai' ? 'https://api.openai.com/v1' : env.OLLAMA_HOST ?? 'http://127.0.0.1:11434')).replace(/\/$/, ''),
  llmApiKey: env.LLM_API_KEY,
  llmModel: env.LLM_MODEL ?? 'qwen2.5-coder:7b',
  llmTimeoutMs: Number(env.LLM_TIMEOUT_SEC ?? 120) * 1000,
  ollamaHost: env.OLLAMA_HOST ?? 'http://127.0.0.1:11434', // nur für kubectl-ai mit Provider ollama
  authEnabled: env.AUTH_ENABLED === 'true',
  auditEnabled: env.AUDIT_ENABLED === 'true',
};

/** Unsichere Kombinationen verhindern den Start. */
export function validateConfig() {
  const errs: string[] = [];
  if (!['local', 'readonly', 'production'].includes(mode)) errs.push(`Unbekannter MODE: ${mode}`);
  if (mode === 'local' && env.HOST && env.HOST !== '127.0.0.1') errs.push('local darf nur an 127.0.0.1 binden');
  if (mode === 'local' && config.k8sAuth === 'incluster') errs.push('local ist nicht für den Betrieb im Cluster gedacht – MODE=readonly verwenden');
  if (mode === 'production' && !config.authEnabled) errs.push('production erfordert AUTH_ENABLED=true (noch nicht implementiert)');
  if (mode === 'production' && !config.auditEnabled) errs.push('production erfordert AUDIT_ENABLED=true (noch nicht implementiert)');
  if (errs.length) {
    console.error('Konfigurationsfehler:\n- ' + errs.join('\n- '));
    process.exit(1);
  }
}
