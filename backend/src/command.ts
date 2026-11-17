import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { checkManifest } from './manifest.js';
import { complete } from './llm.js';
import { COMMAND_SYSTEM, commandUser, KUBECTL_AI_INSTRUCTION, SUMMARY_SYSTEM, summaryUser } from './prompts.js';

export interface Proposal {
  id: string; command: string; args: string[]; destructive: boolean;
  warning?: string; manifest?: string; // manifest wird per stdin an "kubectl apply -f -" gegeben
  question?: string;                    // ursprüngliche Frage (für die Antwort in Alltagssprache)
}
export type Exists = (kind: string, ns: string, name: string) => boolean;

const pending = new Map<string, { p: Proposal; expires: number }>();

function register(p: Omit<Proposal, 'id'>): Proposal {
  const full = { id: randomUUID(), ...p };
  pending.set(full.id, { p: full, expires: Date.now() + 5 * 60_000 });
  return full;
}

const ctxArg = () => (config.k8sAuth === 'kubeconfig' ? [`--context=${config.kubeContext}`] : []);

function run(bin: string, args: string[], timeout = 60_000, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OLLAMA_HOST: config.ollamaHost };
    const child = execFile(bin, args, { timeout, maxBuffer: 1 << 20, windowsHide: true, env }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout || stderr));
    child.stdin?.end(input); // sonst leer: keine interaktiven Rückfragen (z.B. Freigaben in kubectl-ai) beantwortbar
  });
}

/** Manifest prüfen und als Vorschlag "kubectl apply" registrieren. */
export function proposeManifest(text: string, ns: string | undefined, exists: Exists): Proposal {
  const m = checkManifest(text, ns || 'default');
  const updates = m.objects.filter(o => exists(o.kind, o.namespace, o.name));
  return register({
    command: `kubectl apply: ${m.objects.map(o => `${o.kind} ${o.namespace}/${o.name}`).join(', ')}`,
    args: ['apply', '-f', '-', ...ctxArg()],
    manifest: m.yaml,
    destructive: updates.length > 0,
    warning: updates.length ? `Überschreibt bestehende Ressourcen: ${updates.map(o => o.name).join(', ')}` : undefined,
  });
}

export type UiAction = { action: 'focus' | 'select' | 'filter'; target: string } | { action: 'reset' };
/** Nur bekannte, rein darstellende Aktionen durchlassen. */
function sanitizeUi(raw: unknown): UiAction[] {
  if (!Array.isArray(raw)) return [];
  const out: UiAction[] = [];
  for (const a of raw.slice(0, 4)) {
    if (a?.action === 'reset') out.push({ action: 'reset' });
    else if (['focus', 'select', 'filter'].includes(a?.action) && typeof a.target === 'string' && /^[\w .\/-]{1,100}$/.test(a.target))
      out.push({ action: a.action, target: a.target.trim() });
  }
  return out;
}

/** Fragt das Sprachmodell (bzw. kubectl-ai). Es wird nichts ausgeführt. */
async function askLLM(text: string, clusterContext: string): Promise<{ out: string; json: boolean }> {
  if (config.commandEngine === 'kubectl-ai') {
    const prompt = `${KUBECTL_AI_INSTRUCTION}\nCluster: ${clusterContext}\nAnweisung: ${text}`;
    // kubectl-ai verweigert Schreibbefehle im --quiet-Modus und nennt sie → als Vorschlag übernehmen.
    try {
      return { out: await run('kubectl-ai', ['--quiet', '--llm-provider', config.llmProvider, '--model', config.llmModel, prompt], config.llmTimeoutMs), json: false };
    } catch (e: any) {
      const m = /require approval:\s*\n\* (.+)/.exec(e.message);
      if (m) return { out: 'kubectl ' + m[1].trim(), json: false };
      throw e;
    }
  }
  const out = await complete([{ role: 'system', content: COMMAND_SYSTEM }, { role: 'user', content: commandUser(text, clusterContext) }], { json: true });
  return { out, json: true };
}

/** Quote-bewusstes Aufteilen ohne Shell. */
function tokenize(cmd: string): string[] {
  return [...cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}

const FORBIDDEN_VERBS = new Set(['exec', 'attach', 'port-forward', 'proxy', 'edit', 'cp', 'debug', 'auth', 'config', 'plugin']);

export function validate(command: string): { args: string[]; destructive: boolean } {
  if (/[;&|`$<>\\\n]/.test(command)) throw new Error('Shell-Syntax ist nicht erlaubt');
  const t = tokenize(command);
  if (t[0] !== 'kubectl' || t.length < 2) throw new Error('Nur kubectl-Befehle sind erlaubt');
  const args = t.slice(1);
  const verb = args.find(a => !a.startsWith('-'))!;
  if (FORBIDDEN_VERBS.has(verb)) throw new Error(`kubectl ${verb} ist nicht erlaubt`);
  if (args.some(a => /^secrets?$|^secrets?\/|^secret,/i.test(a) || /^(-f|--filename|--kubeconfig|--token|--server|--as)/.test(a)))
    throw new Error('Secrets, Dateien und Credential-Flags sind nicht erlaubt');
  if (config.namespaces.length) {
    const i = args.findIndex(a => a === '-n' || a === '--namespace');
    const ns = i >= 0 ? args[i + 1] : args.find(a => a.startsWith('--namespace='))?.split('=')[1];
    if (!ns || !config.namespaces.includes(ns)) throw new Error(`Namespace muss einer von ${config.namespaces.join(', ')} sein`);
    if (args.some(a => a === '-A' || a === '--all-namespaces')) throw new Error('--all-namespaces nicht erlaubt');
  }
  const destructive = ['delete', 'drain', 'cordon', 'taint', 'replace'].includes(verb)
    || (verb === 'scale' && args.some(a => /^--replicas=0$/.test(a)))
    || (verb === 'rollout' && args.includes('undo'));
  if (!args.some(a => a.startsWith('--context'))) args.push(...ctxArg());
  return { args, destructive };
}

/** Freitext → UI-Aktionen (Ansicht) und/oder Vorschlag (Befehl/Manifest). Ausgeführt wird hier nichts. */
export async function propose(text: string, clusterContext: string, exists: Exists): Promise<{ proposal?: Proposal; ui: UiAction[] }> {
  const { out, json } = await askLLM(text, clusterContext);
  if (json) {
    let o: any;
    try { o = JSON.parse(out); } catch { throw new Error(`Antwort des Modells ist kein gültiges JSON: ${out.slice(0, 200)}`); }
    const ui = sanitizeUi(o.ui);
    const manifest = typeof o.manifest === 'string' && o.manifest.includes('apiVersion') ? o.manifest : undefined;
    const kubectl = typeof o.kubectl === 'string' && o.kubectl.trim() ? o.kubectl.trim() : undefined;
    if (!ui.length && !manifest && !kubectl) throw new Error('Anweisung nicht verstanden');
    return { ui, proposal: manifest ? proposeManifest(manifest, undefined, exists) : kubectl ? fromText(kubectl, exists) : undefined };
  }
  return { proposal: fromText(out, exists), ui: [] };
}

/** Modellausgabe (Befehlszeile bzw. kubectl-ai-Text oder YAML) → geprüfter Vorschlag. Keine inhaltlichen Korrekturen. */
function fromText(out: string, exists: Exists): Proposal {
  // LLM hat ein Manifest geliefert?
  const y = /(?:```(?:ya?ml)?\s*\n)?(apiVersion:[\s\S]*?)(?:```|$)/.exec(out);
  if (y && !/^\s*kubectl /m.test(out.slice(0, y.index))) return proposeManifest(y[1], undefined, exists);
  // Ausgabeformat von kubectl-ai: Terminalfarben, Codeblock-Zeichen, Zeilenumbruch bei ~80 Zeichen
  const lines = out.split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/^[`$\s]+|`+$/g, '').trim());
  const i = lines.findIndex(l => l.startsWith('kubectl '));
  if (i < 0) throw new Error(`Kein kubectl-Befehl erkannt: ${out.slice(0, 200)}`);
  let line = lines[i];
  for (let j = i + 1; j < lines.length && lines[j] && !lines[j].startsWith('kubectl '); j++) line += ' ' + lines[j];
  let checked;
  try { checked = validate(line); } catch (e: any) { throw new Error(`${e.message}: ${line}`); }
  return register({ command: line, ...checked, warning: checked.destructive ? 'Destruktive Operation' : undefined });
}

// Nur lesende Befehle dürfen ohne Bestätigung laufen (z.B. aus dem Kontextmenü)
const READ_VERBS = new Set(['get', 'describe', 'logs', 'explain', 'api-resources', 'version']);
export function isReadOnly(args: string[]) {
  const verb = args.find(a => !a.startsWith('-'));
  return !!verb && (READ_VERBS.has(verb) || (verb === 'rollout' && (args.includes('status') || args.includes('history'))));
}

/** Fertiger kubectl-Befehl (z.B. aus dem Kontextmenü) ohne LLM: gleiche Prüfung wie LLM-Vorschläge. */
export function proposeDirect(command: string): Proposal {
  let checked;
  try { checked = validate(command.trim()); } catch (e: any) { throw new Error(`${e.message}: ${command}`); }
  return register({ command: command.trim(), ...checked, warning: checked.destructive ? 'Destruktive Operation' : undefined });
}

/** Führt einen bestätigten Vorschlag aus – per execFile, nie über eine Shell. */
export async function execute(id: string): Promise<{ output: string; command: string; question?: string }> {
  const e = pending.get(id);
  pending.delete(id);
  if (!e || e.expires < Date.now()) throw new Error('Vorschlag unbekannt oder abgelaufen');
  const output = (await run('kubectl', e.p.args, 30_000, e.p.manifest)).slice(0, 20_000);
  return { output, command: e.p.command, question: e.p.question };
}

export function cancel(id: string) { pending.delete(id); }

/**
 * Antwort in Alltagssprache (Chat + Sprachausgabe). Das Modell bekommt Frage, Befehl, Ausgabe und den aktuellen
 * Problemstatus des Clusters als Kontext (Daten, keine Korrektur) – zählen, bewerten und formulieren muss das Modell selbst.
 */
export async function summarize(question: string, command: string, output: string, problems: string): Promise<string | undefined> {
  const text = await complete(
    [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: summaryUser(question, command, output, problems) }],
    { maxTokens: 200 });
  return text.trim() || undefined;
}
