// Aktionen für das Kontextmenü, je Objekttyp. Ausführung über das Backend (gleiche Prüfung wie Text-/Sprachbefehle):
// read  = lesend, läuft sofort;  sonst Vorschlag mit Bestätigungskarte;  danger = rot hervorgehoben.
import type { Res } from './types';

export type Action =
  | { kind: 'local'; label: string; id: 'details' | 'focus' | 'copy' }
  | { kind: 'kubectl'; label: string; cmd: string; read?: boolean; danger?: boolean }
  | { kind: 'scale'; label: string; target: string; ns: string; current: number }
  | { kind: 'sep' };

const sel = (s?: Record<string, string>) => Object.entries(s ?? {}).map(([k, v]) => `${k}=${v}`).join(',');

export function actionsFor(r: Res): Action[] {
  const ns = r.namespace ?? '';
  const local: Action[] = [
    { kind: 'local', label: 'Details', id: 'details' },
    { kind: 'local', label: 'Fokussieren', id: 'focus' },
    { kind: 'local', label: 'Name kopieren', id: 'copy' },
    { kind: 'sep' },
  ];
  switch (r.kind) {
    case 'Pod': return [...local,
      { kind: 'kubectl', label: 'Logs (letzte 200 Zeilen)', cmd: `kubectl logs ${r.name} -n ${ns} --all-containers --tail=200`, read: true },
      { kind: 'kubectl', label: 'Vorherige Logs (nach Absturz)', cmd: `kubectl logs ${r.name} -n ${ns} --all-containers --previous --tail=200`, read: true },
      { kind: 'kubectl', label: 'Beschreiben', cmd: `kubectl describe pod ${r.name} -n ${ns}`, read: true },
      { kind: 'kubectl', label: 'Events', cmd: `kubectl get events -n ${ns} --field-selector involvedObject.name=${r.name} --sort-by=.lastTimestamp`, read: true },
      { kind: 'sep' },
      { kind: 'kubectl', label: 'Neu starten (Pod löschen)', cmd: `kubectl delete pod ${r.name} -n ${ns}`, danger: true },
    ];
    case 'Deployment': return [...local,
      { kind: 'kubectl', label: 'Pods anzeigen', cmd: `kubectl get pods -n ${ns} -l ${sel(r.selector)} -o wide`, read: true },
      { kind: 'kubectl', label: 'Rollout-Status', cmd: `kubectl rollout status deployment/${r.name} -n ${ns} --timeout=5s`, read: true },
      { kind: 'kubectl', label: 'Rollout-Historie', cmd: `kubectl rollout history deployment/${r.name} -n ${ns}`, read: true },
      { kind: 'kubectl', label: 'Beschreiben', cmd: `kubectl describe deployment ${r.name} -n ${ns}`, read: true },
      { kind: 'sep' },
      { kind: 'scale', label: 'Skalieren', target: `deployment/${r.name}`, ns, current: r.replicas ?? 0 },
      { kind: 'kubectl', label: 'Neu starten (Rollout)', cmd: `kubectl rollout restart deployment/${r.name} -n ${ns}` },
      { kind: 'kubectl', label: 'Rollback auf vorherige Version', cmd: `kubectl rollout undo deployment/${r.name} -n ${ns}`, danger: true },
      { kind: 'kubectl', label: 'Löschen', cmd: `kubectl delete deployment ${r.name} -n ${ns}`, danger: true },
    ];
    case 'Service': return [...local,
      { kind: 'kubectl', label: 'Endpoints', cmd: `kubectl get endpoints ${r.name} -n ${ns} -o wide`, read: true },
      { kind: 'kubectl', label: 'Pods dahinter', cmd: `kubectl get pods -n ${ns} -l ${sel(r.selector)} -o wide`, read: true },
      { kind: 'kubectl', label: 'Beschreiben', cmd: `kubectl describe service ${r.name} -n ${ns}`, read: true },
      { kind: 'sep' },
      { kind: 'kubectl', label: 'Löschen', cmd: `kubectl delete service ${r.name} -n ${ns}`, danger: true },
    ];
    case 'PVC': return [...local,
      { kind: 'kubectl', label: 'Beschreiben', cmd: `kubectl describe pvc ${r.name} -n ${ns}`, read: true },
      { kind: 'kubectl', label: 'Events', cmd: `kubectl get events -n ${ns} --field-selector involvedObject.name=${r.name} --sort-by=.lastTimestamp`, read: true },
      { kind: 'kubectl', label: 'Volume (PV)', cmd: `kubectl get pv ${r.volumeName ?? ''} -o wide`, read: true },
      { kind: 'sep' },
      { kind: 'kubectl', label: 'Löschen (Daten weg!)', cmd: `kubectl delete pvc ${r.name} -n ${ns}`, danger: true },
    ];
    case 'Ingress': return [...local,
      { kind: 'kubectl', label: 'Beschreiben', cmd: `kubectl describe ingress ${r.name} -n ${ns}`, read: true },
      { kind: 'kubectl', label: 'Services dahinter', cmd: `kubectl get services -n ${ns} ${[...new Set((r.rules ?? []).map(x => x.service).filter(Boolean))].join(' ')}`, read: true },
      { kind: 'kubectl', label: 'Events', cmd: `kubectl get events -n ${ns} --field-selector involvedObject.name=${r.name} --sort-by=.lastTimestamp`, read: true },
      { kind: 'sep' },
      { kind: 'kubectl', label: 'Löschen', cmd: `kubectl delete ingress ${r.name} -n ${ns}`, danger: true },
    ];
    case 'Namespace': return [
      { kind: 'local', label: 'Fokussieren', id: 'focus' },
      { kind: 'local', label: 'Name kopieren', id: 'copy' },
      { kind: 'sep' },
      { kind: 'kubectl', label: 'Pods', cmd: `kubectl get pods -n ${r.name} -o wide`, read: true },
      { kind: 'kubectl', label: 'Deployments & Services', cmd: `kubectl get deployments,services -n ${r.name}`, read: true },
      { kind: 'kubectl', label: 'Events (neueste zuletzt)', cmd: `kubectl get events -n ${r.name} --sort-by=.lastTimestamp`, read: true },
      { kind: 'kubectl', label: 'Beschreiben', cmd: `kubectl describe namespace ${r.name}`, read: true },
    ];
    default: return local;
  }
}

/** Aktionen, die Befehle brauchen, im Modus readonly ausblenden. */
export const needsCommands = (a: Action) => a.kind === 'kubectl' || a.kind === 'scale';
