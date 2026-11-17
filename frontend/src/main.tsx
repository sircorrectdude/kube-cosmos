import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Scene } from './Scene';
import { Panel } from './Panel';
import { Hud } from './Hud';
import { Nav } from './Nav';
import { Timeline } from './Timeline';
import { useCluster } from './useCluster';
import { CommandBar } from './CommandBar';
import { ContextMenu, type MenuState } from './ContextMenu';
import { parseIntent, resolveTarget, type UiAction } from './intent';
import './style.css';

function App() {
  const { model, events, mode, connected, commandsEnabled, status, setUiHandler,
    chat, ask, runCmd, note, sendManifest, confirm, cancel, clearChat, localError,
    replay, replayRange, replaySeek, replayPlay, replayPause, replayLive } = useCluster();
  const [replayOpen, setReplayOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [overview, setOverview] = useState(0);
  const [clean, setClean] = useState(false); // nur Szene, alle Panels aus
  const toOverview = useCallback(() => { setFocus(null); setOverview(v => v + 1); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !menu) { setFocus(null); setSelected(null); }
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select');
      if (!typing && (e.key === 'Home' || e.key === 'o')) toOverview();
      if (!typing && e.key === 'h') setClean(c => !c);
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [menu, toOverview]);
  // Kontextmenü-Aktion: lesend sofort, sonst Vorschlag im Chat (Backend prüft beides); label = Anlass für die Antwort
  const run = useCallback((command: string, read: boolean, label: string) => runCmd(command, read, label, undefined, label), [runCmd]);
  const closeMenu = useCallback(() => setMenu(null), []);

  /** UI-Aktionen ausführen (lokal erkannt oder vom Sprachmodell). Ziele: Knoten-ID oder (unscharfer) Name. */
  const applyUi = useCallback((actions: UiAction[]) => {
    for (const a of actions) {
      if (a.action === 'reset') { model.setNsFilter(null); setSelected(null); toOverview(); continue; }
      if (a.action === 'filter') {
        const n = resolveTarget(model, 'namespace ' + a.target) ?? resolveTarget(model, a.target);
        const ns = n && (n.res.kind === 'Namespace' ? n.res.name : n.res.namespace);
        if (ns) model.setNsFilter(ns);
        continue;
      }
      const n = model.nodes.get(a.target) ?? resolveTarget(model, a.target);
      if (!n) continue;
      if (!model.visible(n)) model.setNsFilter(null); // Ziel liegt außerhalb des Filters
      setSelected(n.id);
      if (a.action === 'focus') setFocus(n.id);
    }
  }, [model, toOverview]);
  useEffect(() => setUiHandler(applyUi), [setUiHandler, applyUi]);

  /** Stufe A: Navigation lokal (sofort). Bei forward geht der Satz zusätzlich ans Sprachmodell. false = nur Sprachmodell. */
  const onLocal = useCallback((text: string) => {
    const intent = parseIntent(text, model);
    if (!intent) return false;
    applyUi(intent.ui);
    if (intent.forward && commandsEnabled) ask(text, intent.label);
    else note(text, intent.label);
    return true;
  }, [model, applyUi, ask, note, commandsEnabled]);

  return (
    <>
      <div className="scene" onContextMenu={e => e.preventDefault()}>
        <Scene model={model} hovered={hovered} selected={selected} onHover={setHovered} onSelect={setSelected}
          focus={focus} onFocus={setFocus} onMenu={(id, x, y) => setMenu({ id, x, y })} overview={overview} />
      </div>
      {clean ? <button className="unclean" onClick={() => setClean(false)} title="Panels wieder einblenden (Taste H)">▣ Panels</button> : <>
      <Nav model={model} replay={replay.available ? () => setReplayOpen(o => !o) : undefined} replayOn={replayOpen} onClean={() => setClean(true)} onOverview={toOverview} onFilter={ns => { model.setNsFilter(ns); setSelected(null); toOverview(); }} />
      {replayOpen && <Timeline r={replay} range={replayRange} seek={replaySeek} play={replayPlay} pause={replayPause}
        live={replayLive} onClose={() => setReplayOpen(false)} />}
      <Hud model={model} mode={mode} connected={connected} status={status} />
      <Panel model={model} selected={selected} events={events} onPick={e => {
        const n = model.eventTarget(e);
        if (!n) return;
        if (!model.visible(n)) model.setNsFilter(null);
        setSelected(n.id); setFocus(n.id);
      }} />
      <CommandBar enabled={commandsEnabled && !replay.active} mode={mode} chat={chat} onLocal={onLocal} ask={ask} sendManifest={sendManifest}
        confirm={confirm} cancel={cancel} clearChat={clearChat} localError={localError} />
      </>}
      {menu && !clean && (
        <ContextMenu menu={menu} model={model} commandsEnabled={commandsEnabled} run={run}
          onDetails={setSelected} onFocus={setFocus} onClose={closeMenu} />
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
