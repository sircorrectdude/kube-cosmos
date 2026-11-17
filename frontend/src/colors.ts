import type { Res } from './types';

const OK = '#3cf0a0', WAIT = '#ffc94a', BAD = '#ff3b5c', DONE = '#4aa8ff', GONE = '#777777';
const STARTING = '#b48cff', UNREADY = '#ff9f43';

const byStatus: Record<string, string> = {
  Running: OK, Ready: OK, Active: OK, Available: OK,
  Pending: WAIT, ContainerCreating: WAIT, PodInitializing: WAIT, Progressing: WAIT,
  Starting: STARTING, Unready: UNREADY,
  Succeeded: DONE, Completed: DONE,
  Terminating: GONE,
  CrashLoopBackOff: BAD, Error: BAD, Failed: BAD, ImagePullBackOff: BAD, ErrImagePull: BAD, NotReady: BAD, CreateContainerConfigError: BAD, OOMKilled: BAD, ContainerCannotRun: BAD,
};

export const LEGEND: [string, string][] = [
  ['Running', OK], ['Pending', WAIT], ['Startup-Probe', STARTING], ['Nicht ready', UNREADY], ['Fehler', BAD], ['Fertig', DONE],
];
export const SUN = '#ffd98a';
export const INGRESS = '#c78bff'; // Ingress-Portal
export const PVC = '#ffb86b';     // Speicher (PVC)     // k8s-Node
/** HPA-Ring: stabil, skaliert gerade, am Maximum */
export const HPA_COLORS: Record<string, string> = { Stable: '#7ad7ff', Scaling: WAIT, AtMax: '#ff8a3d' };
export const HOT = '#ff8a3d';      // CPU-Last (Prometheus)
export const MEM_ALERT = '#ff3b5c'; // Speicher nahe am Limit

/** CPU-Hitze 0..1: Anteil am Limit/Request, sonst absolut (0,5 Kerne = voll). */
export function heatOf(m?: { cpu: number; cpuRel?: number }) {
  if (!m) return 0;
  return Math.min(1, m.cpuRel ?? m.cpu / 0.5);
}

export const PROBE_COLOR = { ok: OK, wait: STARTING, fail: BAD } as const;

function hue(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function colorOf(r: Res): string {
  if (r.kind === 'Namespace') return `hsl(${hue(r.name)}, 80%, 65%)`;
  if (r.kind === 'Service') return '#5ee7ff';
  if (r.kind === 'PVC') return r.status === 'Bound' ? PVC : r.status === 'Lost' ? BAD : r.status === 'Terminating' ? GONE : WAIT;
  if (r.kind === 'Ingress') return r.status === 'Active' ? INGRESS : WAIT; // Portal; ohne Adresse = wartend
  if (r.kind === 'Node') return r.status !== 'Ready' ? BAD : r.unschedulable ? GONE : SUN; // Sonne; cordon = grau
  if (r.kind === 'External') return AGENT_COLORS[r.status ?? ''] ?? AGENT_COLORS.unbekannt; // Satellit nach Client-Typ
  return byStatus[r.status ?? ''] ?? WAIT;
}

/** Puls-Stärke: stark bei Fehlern, sanft bei laufender Startup-/Readiness-Phase. */
export function pulseOf(r: Res): [amp: number, speed: number] {
  const c = colorOf(r);
  if (c === BAD) return [0.25, 6];
  if (c === STARTING || c === UNREADY) return [0.15, 3];
  if (r.kind === 'PVC' && r.status === 'Pending') return [0.2, 4]; // wartet auf Volume
  return [0, 0];
}

/** Satelliten-Farbe je Client-Typ (aus dem User-Agent) */
export const AGENT_COLORS: Record<string, string> = {
  Browser: '#ffd27a', Skript: '#7ad7ff', Bot: '#ff7ae0', Monitoring: '#9dff7a', unbekannt: '#c8c8d8',
};
