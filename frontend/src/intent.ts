// Stufe A: reine Navigation im Browser, sofort und ohne Sprachmodell (auch im Modus readonly).
// Bewusst KEINE Antworten, Zählungen oder kubectl-Befehle: das ist Aufgabe des Sprachmodells (Stufe B), damit
// ein besseres Modell ohne Codeänderung bessere Ergebnisse liefert.
import type { GNode, GraphModel } from './graph';
import type { Res } from './types';

export type UiAction =
  | { action: 'focus' | 'select'; target: string }
  | { action: 'filter'; target: string }
  | { action: 'reset' };

/** forward = Satz zusätzlich ans Sprachmodell geben (Antwort/Befehl), lokal wurde nur die Ansicht schon angepasst. */
export interface Intent { ui: UiAction[]; label: string; forward: boolean }

/** Für den Namensvergleich: klein, ohne Leerzeichen/Bindestriche/Punkte, Umlaute vereinfacht. */
const norm = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[\s\-_.]/g, '');

function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const KIND_RANK: Record<string, number> = { Namespace: 0, Deployment: 1, Service: 2, Pod: 3 };
const KIND_WORD: Record<string, Res['kind']> = {
  namespace: 'Namespace', deployment: 'Deployment', deployments: 'Deployment', service: 'Service', dienst: 'Service', pod: 'Pod',
};

/**
 * Unscharfe Suche nach einem Objekt (toleriert Hörfehler der Spracherkennung, z.B. „Traffic Demo“):
 * exakt > Anfang > enthält > Tippfehler (≤ 2). Namespace vor Deployment vor Service vor Pod.
 * Wird auch für Ziele aus UI-Aktionen des Sprachmodells genutzt.
 */
export function resolveTarget(model: GraphModel, raw: string): GNode | undefined {
  let words = raw.trim().toLowerCase().split(/\s+/).filter(w => !['das', 'den', 'die', 'dem', 'der', 'im', 'in', 'von', 'vom', 'zu', 'zum'].includes(w));
  let kind: Res['kind'] | undefined;
  words = words.filter(w => (KIND_WORD[w] ? ((kind = KIND_WORD[w]), false) : true));
  const q = norm(words.join(' '));
  if (!q) return;
  const nodes = [...model.nodes.values()].filter(n => !kind || n.res.kind === kind);
  const score = (n: GNode) => {
    const name = norm(n.res.name);
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    const d = lev(name, q);
    return d <= Math.min(2, Math.floor(q.length / 4)) ? 3 + d : Infinity;
  };
  let best: GNode | undefined, bestScore = Infinity;
  for (const n of nodes) {
    const s = score(n) * 10 + (KIND_RANK[n.res.kind] ?? 9);
    if (s < bestScore) { best = n; bestScore = s; }
  }
  return bestScore < Infinity ? best : undefined;
}

const ref = (r: Res) => (r.kind === 'Namespace' ? r.name : `${r.kind.toLowerCase()} ${r.name}`);

/** Navigationssätze lokal verstehen; null = komplett ans Sprachmodell. */
export function parseIntent(text: string, model: GraphModel): Intent | null {
  const t = text.trim().toLowerCase().replace(/[\s.!?,]+$/g, '').replace(/\s+/g, ' ');
  let m: RegExpMatchArray | null;

  if (/^(zurück|übersicht|zur übersicht|alles( zeigen)?|alle( zeigen)?|zeige? alles|filter (aus|weg|entfernen)|reset)$/.test(t))
    return { ui: [{ action: 'reset' }], label: 'Übersicht', forward: false };

  if ((m = t.match(/^nur (?:noch )?(?:den |das )?(?:namespace )?(.+?)(?: zeigen| anzeigen)?$/))) {
    const n = resolveTarget(model, m[1]);
    const ns = n && (n.res.kind === 'Namespace' ? n.res.name : n.res.namespace);
    if (ns) {
      const nsNode = [...model.nodes.values()].find(x => x.res.kind === 'Namespace' && x.res.name === ns);
      return { ui: [{ action: 'filter', target: ns }, ...(nsNode ? [{ action: 'focus' as const, target: nsNode.id }] : [])], label: `nur ${ns}`, forward: false };
    }
  }

  // „zeige X“: Kamera sofort hinbewegen; Antwort und passenden Befehl liefert das Sprachmodell
  if ((m = t.match(/^(?:zeige?(?: mir)?|fokussiere|fokus auf|geh(?:e)? zu|gehe? zum|springe? zu|zoom(?:e)? auf|öffne|wo ist) (.+)$/))) {
    const n = resolveTarget(model, m[1]);
    if (n) return { ui: [{ action: 'focus', target: n.id }], label: `zeige ${ref(n.res)}`, forward: true };
  }
  return null;
}
