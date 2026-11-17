// Verbindungsstatus aller Datenquellen (Kubernetes, Prometheus, Traffic, Sprachmodell …) für das Status-Panel.
// Neue Quellen melden sich einfach per setStatus() an – das Frontend zeigt alle Einträge in Reihenfolge der Anmeldung.

export type StatusState = 'ok' | 'warn' | 'error' | 'off' | 'unknown';
export interface ServiceStatus { id: string; label: string; state: StatusState; detail?: string; since: number }

const items = new Map<string, ServiceStatus>();
const listeners = new Set<() => void>();
let pending: NodeJS.Timeout | undefined;

export function setStatus(id: string, label: string, state: StatusState, detail?: string) {
  const cur = items.get(id);
  if (cur && cur.state === state && cur.detail === detail) return;
  items.set(id, { id, label, state, detail, since: cur?.state === state ? cur.since : Date.now() });
  // Änderungen gebündelt melden (max. 2×/s)
  pending ??= setTimeout(() => { pending = undefined; listeners.forEach(l => l()); }, 500);
}

export const statusList = () => [...items.values()];
export function onStatus(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }
