import { useSyncExternalStore } from 'react';

/** Globale Anzeige-Einstellungen (pro Browser, localStorage). */
export interface Settings {
  stars: boolean;        // Sternenhimmel im Hintergrund
  autoRotate: boolean;   // Kamera dreht langsam, solange nichts fokussiert ist
  bloom: number;         // Leuchten 0..2
  nodeLines: number;     // Helligkeit der Kraftlinien Pod→Node 0..3
  traffic: boolean;      // Traffic-Kometen
  sparks: boolean;       // Event-Funken an Objekten
  labels: boolean;       // Namen von Namespaces/Nodes/Satelliten dauerhaft
  routing: boolean;      // Requests laufen über Ingress/Service statt direkt zum Pod
  hulls: boolean;        // Hüllen um Namespaces/Deployments statt Baum-Linien
}

export const DEFAULTS: Settings = { stars: true, autoRotate: true, bloom: 1.3, nodeLines: 1, traffic: true, sparks: true, labels: true, routing: true, hulls: true };
const KEY = 'kube-cosmos.settings';

let current: Settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { ...DEFAULTS }; }
})();
const listeners = new Set<() => void>();

/** Aktuelle Einstellungen außerhalb von React (z.B. in useFrame). */
export const getSettings = () => current;

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* egal */ }
  listeners.forEach(l => l());
}

export function useSettings() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getSettings);
}
