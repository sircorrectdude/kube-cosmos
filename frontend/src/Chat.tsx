import { useEffect, useRef, useState } from 'react';
import type { ChatEntry } from './useCluster';

const SPEECH_KEY = 'kube-cosmos.speech';
const synth: SpeechSynthesis | undefined = (window as any).speechSynthesis;

/** Antwort vorlesen (deutsche Stimme, falls vorhanden). */
function speak(text: string) {
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  const de = synth.getVoices().find(v => v.lang?.toLowerCase().startsWith('de'));
  if (de) u.voice = de;
  synth.speak(u);
}

/** Technische Fehlermeldung → verständlicher Satz (Original bleibt unter „Technische Details“). */
export function friendlyError(err: string): string {
  if (/Shell-Syntax/.test(err)) return 'Dafür hätte ich eine Befehlskette gebraucht, die ich aus Sicherheitsgründen nicht ausführe. Formuliere die Frage bitte etwas einfacher.';
  if (/Secrets|Credential/.test(err)) return 'Auf Secrets und Zugangsdaten greife ich aus Sicherheitsgründen nicht zu.';
  if (/ist nicht erlaubt/.test(err)) return 'Diese Art von Befehl ist aus Sicherheitsgründen nicht erlaubt.';
  if (/NotFound|not found/i.test(err)) return 'Das gesuchte Objekt habe ich nicht gefunden. Prüfe bitte Name und Namespace.';
  if (/nicht verstanden|Kein kubectl-Befehl|kein gültiges JSON/.test(err)) return 'Das habe ich leider nicht verstanden. Versuch es bitte anders formuliert.';
  if (/Ollama|fetch failed|ECONNREFUSED/.test(err)) return 'Das Sprachmodell ist gerade nicht erreichbar.';
  if (/deaktiviert|nur Ansichtsbefehle/.test(err)) return err;
  if (/abgelaufen/.test(err)) return 'Der Vorschlag ist abgelaufen. Bitte frag noch einmal.';
  return 'Das hat leider nicht geklappt.';
}

/** Chatverlauf: Fragen, Antworten in Alltagssprache, Vorschläge; Befehl + Rohausgabe nur auf Wunsch (Technische Details). */
export function Chat({ chat, onConfirm, onCancel, onClear }: {
  chat: ChatEntry[]; onConfirm: (rid: string) => void; onCancel: (rid: string) => void; onClear: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [voice, setVoice] = useState(() => { try { return localStorage.getItem(SPEECH_KEY) !== 'off'; } catch { return true; } });
  const listRef = useRef<HTMLDivElement>(null);
  const spoken = useRef(new Set(chat.filter(e => e.answer || e.error).map(e => e.rid))); // Verlauf beim Laden nicht vorlesen

  useEffect(() => { try { localStorage.setItem(SPEECH_KEY, voice ? 'on' : 'off'); } catch { /* egal */ } if (!voice) synth?.cancel(); }, [voice]);

  // neue Antworten (und verständliche Fehlermeldungen) vorlesen
  useEffect(() => {
    for (const e of chat) {
      const say = e.answer ?? (e.error ? friendlyError(e.error) : undefined);
      if (e.role === 'bot' && say && !spoken.current.has(e.rid)) { spoken.current.add(e.rid); if (voice) speak(say); }
    }
  }, [chat, voice]);

  // ans Ende scrollen
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [chat, open]);

  if (!chat.length) return null;
  return (
    <div className={'chat' + (open ? '' : ' closed')}>
      <div className="chathead">
        <button onClick={() => setOpen(o => !o)} title={open ? 'Einklappen' : 'Ausklappen'}>{open ? '▾' : '▸'} Verlauf ({chat.filter(e => e.role === 'user').length})</button>
        <span className="spacer" />
        {synth && <button onClick={() => setVoice(v => !v)} title="Sprachausgabe">{voice ? '🔊' : '🔇'}</button>}
        <button onClick={onClear} title="Verlauf leeren">Leeren</button>
      </div>
      {open && (
        <div className="chatlist" ref={listRef}>
          {chat.map(e => e.role === 'user'
            ? <div key={e.rid + 'u'} className="msg user">{e.text}</div>
            : <BotMsg key={e.rid + 'b'} e={e} onConfirm={onConfirm} onCancel={onCancel} onSpeak={() => e.answer && speak(e.answer)} />)}
        </div>
      )}
    </div>
  );
}

function BotMsg({ e, onConfirm, onCancel, onSpeak }: { e: ChatEntry; onConfirm: (rid: string) => void; onCancel: (rid: string) => void; onSpeak: () => void }) {
  const [details, setDetails] = useState(false);
  const p = e.proposal;
  const tech = e.command || p?.command || (e.error && friendlyError(e.error) !== e.error ? '(Originalmeldung)' : undefined);
  return (
    <div className={'msg bot' + (e.error ? ' err' : '')}>
      {e.label && <div className="lbl">✓ {e.label}</div>}
      {e.answer && <div className="answer">{e.answer} <button className="say" onClick={onSpeak} title="Vorlesen">🔈</button></div>}
      {e.error && <div className="error">{friendlyError(e.error)}</div>}
      {p && e.status === 'proposed' && (
        <div className={'proposal' + (p.destructive ? ' danger' : '')}>
          {p.warning && <div className="warn">⚠ {p.warning}</div>}
          <code>{p.command}</code>
          {p.manifest && <pre className="manifest">{p.manifest}</pre>}
          <div className="actions">
            <button className="ok" onClick={() => onConfirm(e.rid)}>Ausführen</button>
            <button onClick={() => onCancel(e.rid)}>Abbrechen</button>
            <span className="hint">oder „ja, ausführen“ sagen</span>
          </div>
        </div>
      )}
      {p && e.status === 'cancelled' && <div className="muted">Abgebrochen.</div>}
      {e.pending && <div className="muted">… {e.status === 'confirmed' ? 'führe aus' : 'denke nach'}</div>}
      {!e.pending && e.output && !e.answer && !e.error && (
        <div className="muted">{Date.now() - (e.resultAt ?? 0) < 45_000 ? '… formuliere Antwort' : 'Erledigt.'}</div>
      )}
      {tech && !(p && e.status === 'proposed') && (
        <>
          <button className="techtoggle" onClick={() => setDetails(d => !d)}>{details ? '▾' : '▸'} Technische Details</button>
          {details && (
            <div className="tech">
              <code>{tech}</code>
              {e.output && <pre>{e.output}</pre>}
              {e.error && <pre className="errraw">{e.error}</pre>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
