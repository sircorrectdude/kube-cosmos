import { useRef, useState } from 'react';
import type { ChatEntry } from './useCluster';
import { Chat } from './Chat';

const SR: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
const CONFIRM = /\bja\b.*ausf(ü|ue)hren|^ausf(ü|ue)hren$/i;
const CANCEL = /^(nein|abbrechen|stopp?)\b/i;

/** Eingabe (Text, Mikrofon, YAML) + Chatverlauf darüber. */
export function CommandBar({ enabled, mode, chat, onLocal, ask, sendManifest, confirm, cancel, clearChat, localError }: {
  enabled: boolean; mode: string; chat: ChatEntry[];
  onLocal: (text: string) => boolean;
  ask: (text: string, label?: string) => void;
  sendManifest: (yaml: string, ns?: string) => void;
  confirm: (rid: string) => void; cancel: (rid: string) => void; clearChat: () => void;
  localError: (userText: string, error: string) => void;
}) {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [yamlMode, setYamlMode] = useState(false);
  const [yaml, setYaml] = useState('');
  const [ns, setNs] = useState('default');
  const rec = useRef<any>(null);

  // jüngster offener Vorschlag (für „ja, ausführen“ / „abbrechen“ per Sprache)
  const open = [...chat].reverse().find(e => e.role === 'bot' && e.status === 'proposed');

  const submit = (t: string) => {
    t = t.trim();
    if (!t) return;
    setText('');
    if (open && CONFIRM.test(t)) return confirm(open.rid);
    if (open && CANCEL.test(t)) return cancel(open.rid);
    if (onLocal(t)) return;                       // Stufe A: lokal verstanden (Ansicht + ggf. Befehl)
    if (!enabled) return localError(t, `Im Modus ${mode} nur Ansichtsbefehle, z.B. „zeige traffic-demo“, „nur monitoring“, „zurück“`);
    ask(t);                                       // Stufe B: Sprachmodell
  };

  const toggleMic = () => {
    if (listening) { rec.current?.stop(); return; }
    (window as any).speechSynthesis?.cancel();     // nicht in die eigene Sprachausgabe hineinhören
    const r = new SR();
    r.lang = 'de-DE';
    r.interimResults = true;
    r.onresult = (e: any) => {
      const res = e.results[e.results.length - 1];
      setText(res[0].transcript);
      if (res.isFinal) submit(res[0].transcript);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  };

  return (
    <div className="cmdbar">
      <Chat chat={chat} onConfirm={confirm} onCancel={cancel} onClear={clearChat} />
      {yamlMode ? (
        <div className="yamlbox">
          <textarea value={yaml} onChange={e => setYaml(e.target.value)} spellCheck={false}
            placeholder={'apiVersion: apps/v1\nkind: Deployment\n...'} />
          <div className="row">
            <button type="button" onClick={() => setYamlMode(false)}>KI-Modus</button>
            <label>Namespace (falls nicht im YAML) <input value={ns} onChange={e => setNs(e.target.value)} /></label>
            <button type="button" className="ok" onClick={() => { if (yaml.trim()) { sendManifest(yaml, ns.trim() || undefined); setYamlMode(false); } }}>Prüfen</button>
          </div>
        </div>
      ) : (
        <form onSubmit={e => { e.preventDefault(); submit(text); }}>
          {SR && <button type="button" className={'mic' + (listening ? ' on' : '')} onClick={toggleMic} title="Spracheingabe">🎤</button>}
          <input value={text} onChange={e => setText(e.target.value)}
            placeholder={enabled ? 'z.B. gibt es Pods mit Fehlern? · zeige traffic-demo · logs von cart' : 'z.B. zeige traffic-demo · nur monitoring · zurück'} />
          <button type="submit">Senden</button>
          {enabled && <button type="button" onClick={() => setYamlMode(true)} title="Manifest direkt eingeben">YAML</button>}
        </form>
      )}
    </div>
  );
}
