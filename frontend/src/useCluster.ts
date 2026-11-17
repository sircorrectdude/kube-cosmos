import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GraphModel } from './graph';
import type { KEvent, ServiceStatus } from './types';
import type { UiAction } from './intent';

// Dev: separates Backend auf 7070; gebautes Frontend (Container): dieselbe Adresse wie die Seite
const WS_URL = import.meta.env.VITE_WS_URL
  ?? (import.meta.env.DEV ? 'ws://127.0.0.1:7070/ws' : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

/** Ein Eintrag im Chatverlauf. Bot-Einträge sammeln alles zu einer Anfrage (rid): Absicht, Befehl, Ausgabe, Antwort. */
export interface ChatEntry {
  rid: string;
  role: 'user' | 'bot';
  t: number;
  text?: string;          // Nutzer: Frage
  label?: string;         // Bot: erkannte Absicht, z.B. „zeige traffic-demo“
  pending?: boolean;      // Bot: wartet auf Backend
  command?: string;       // ausgeführter kubectl-Befehl (technisch, eingeklappt)
  output?: string;        // Rohausgabe (technisch, eingeklappt)
  answer?: string;        // Antwort in Alltagssprache (wird vorgelesen)
  resultAt?: number;      // Zeitpunkt des Ergebnisses (Antwort folgt meist wenige Sekunden später)
  error?: string;
  proposal?: { id: string; command: string; destructive: boolean; warning?: string; manifest?: string };
  status?: 'proposed' | 'cancelled' | 'confirmed';
}

const STORE = 'kube-cosmos.chat';
const load = (): ChatEntry[] => {
  try { return (JSON.parse(localStorage.getItem(STORE) ?? '[]') as ChatEntry[]).map(e => ({ ...e, pending: false })); } catch { return []; }
};
const save = (c: ChatEntry[]) => {
  try { localStorage.setItem(STORE, JSON.stringify(c.slice(-80).map(e => ({ ...e, output: e.output?.slice(0, 4000) })))); } catch { /* ohne Speicher weiter */ }
};
const newRid = () => Math.random().toString(36).slice(2, 10);

export function useCluster() {
  const model = useMemo(() => new GraphModel(), []);
  const [events, setEvents] = useState<KEvent[]>([]);
  const [mode, setMode] = useState<string>('?');
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  const [commandsEnabled, setCommandsEnabled] = useState(false);
  const [traffic, setTraffic] = useState('none');
  const [status, setStatus] = useState<ServiceStatus[]>([]);
  const [chat, setChat] = useState<ChatEntry[]>(load);
  const wsRef = useRef<WebSocket | null>(null);
  const send = useCallback((m: object) => wsRef.current?.send(JSON.stringify(m)), []);
  // UI-Aktionen aus dem Sprachmodell (Ansicht steuern); Handler setzt die App
  const uiRef = useRef<((a: UiAction[]) => void) | undefined>(undefined);
  const setUiHandler = useCallback((fn: (a: UiAction[]) => void) => { uiRef.current = fn; }, []);

  useEffect(() => model.subscribe(() => setVersion(v => v + 1)), [model]);
  useEffect(() => save(chat), [chat]);

  // ---- Chat-Verlauf ----
  const patch = useCallback((rid: string, p: Partial<ChatEntry>) =>
    setChat(c => c.map(e => (e.rid === rid && e.role === 'bot' ? { ...e, ...p } : e))), []);
  const add = useCallback((...e: ChatEntry[]) => setChat(c => [...c, ...e].slice(-80)), []);
  const start = useCallback((userText: string | undefined, label?: string, pending = true) => {
    const rid = newRid(), t = Date.now();
    add(...(userText ? [{ rid, role: 'user' as const, t, text: userText }] : []), { rid, role: 'bot', t, label, pending });
    return rid;
  }, [add]);

  /** Freitext/Sprache → Backend/Sprachmodell (Stufe B). */
  const ask = useCallback((text: string, label?: string) => { const rid = start(text, label); send({ type: 'command', text, rid }); }, [start, send]);
  /** Fertiger kubectl-Befehl (lokal erkannt oder Kontextmenü). question = Anlass für die Antwort in Alltagssprache. */
  const runCmd = useCallback((command: string, read: boolean, question: string, label?: string, userText?: string) => {
    const rid = start(userText, label);
    send({ type: 'kubectl', text: command, autoRun: read, question, rid });
  }, [start, send]);
  /** Nur Ansicht, kein Befehl (z.B. „zurück“). */
  const note = useCallback((userText: string, label: string) => { start(userText, label, false); }, [start]);
  const sendManifest = useCallback((yaml: string, namespace?: string) => {
    const rid = start('YAML-Manifest prüfen', undefined);
    send({ type: 'manifest', yaml, namespace, rid });
  }, [start, send]);
  const confirm = useCallback((rid: string) => {
    const e = chat.find(x => x.rid === rid && x.role === 'bot');
    if (!e?.proposal || e.status !== 'proposed') return;
    patch(rid, { status: 'confirmed', pending: true });
    send({ type: 'confirm', id: e.proposal.id, rid });
  }, [chat, patch, send]);
  const cancel = useCallback((rid: string) => {
    const e = chat.find(x => x.rid === rid && x.role === 'bot');
    if (!e?.proposal || e.status !== 'proposed') return;
    patch(rid, { status: 'cancelled' });
    send({ type: 'cancel', id: e.proposal.id, rid });
  }, [chat, patch, send]);
  const clearChat = useCallback(() => setChat([]), []);
  const localError = useCallback((userText: string, error: string) => { const rid = start(userText); patch(rid, { pending: false, error }); }, [start, patch]);

  useEffect(() => {
    let ws: WebSocket; let retry: number; let closed = false;
    const connect = () => {
      ws = wsRef.current = new WebSocket(WS_URL);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); model.sync([]); // Backend weg → Objekte verglühen, Snapshot bringt sie zurück
        if (!closed) retry = window.setTimeout(connect, 2000); };
      ws.onmessage = m => {
        const d = JSON.parse(m.data);
        const rid: string | undefined = d.rid;
        if (d.type === 'flows') model.addFlows(d.flows);
        else if (d.type === 'status') setStatus(d.status ?? []);
        else if (d.type === 'metrics') model.applyMetrics(d.pods, d.nodes, d.volumes);
        else if (d.type === 'ui') uiRef.current?.(d.actions);
        else if (rid && d.type === 'thinking') patch(rid, { pending: true });
        else if (rid && d.type === 'idle') patch(rid, { pending: false, label: 'Ansicht angepasst' });
        else if (rid && d.type === 'proposal') patch(rid, { pending: false, status: 'proposed', proposal: { id: d.id, command: d.command, destructive: d.destructive, warning: d.warning, manifest: d.manifest } });
        else if (rid && d.type === 'commandResult') patch(rid, { pending: false, command: d.command, output: d.output || '(keine Ausgabe)', resultAt: Date.now() });
        else if (rid && d.type === 'answer') patch(rid, { answer: d.text });
        else if (rid && d.type === 'cancelled') patch(rid, { status: 'cancelled', pending: false });
        else if (rid && d.type === 'commandError') patch(rid, { pending: false, error: d.error });
        else if (d.type === 'snapshot') {
          model.metricsSource = d.metrics?.source;
          setMode(d.mode); setTraffic(d.traffic ?? 'none'); setCommandsEnabled(d.commandsEnabled); setStatus(d.status ?? []);
          model.sync(d.resources);
          if (d.metrics) model.applyMetrics(d.metrics.pods, d.metrics.nodes, d.metrics.volumes);
          setEvents(d.events.slice(-100).reverse());
        }
        else if (d.type === 'upsert') model.upsert(d.res);
        else if (d.type === 'delete') model.remove(d.uid);
        else if (d.type === 'event') { model.sparkEvent(d.event); setEvents(e => [d.event, ...e].slice(0, 100)); }
      };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); ws.close(); };
  }, [model, patch]);

  return {
    model, events, mode, connected, version, commandsEnabled, traffic, status, setUiHandler,
    chat, ask, runCmd, note, sendManifest, confirm, cancel, clearChat, localError,
  };
}
