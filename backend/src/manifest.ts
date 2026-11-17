import { parseAllDocuments, stringify } from 'yaml';
import { config } from './config.js';

// Nur Workload-/Netzwerk-Ressourcen. Bewusst nicht: Secret, RBAC, ServiceAccount, CRDs, Webhooks, Namespace.
const ALLOWED = new Set([
  'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Pod', 'Job', 'CronJob',
  'Service', 'ConfigMap', 'Ingress', 'HorizontalPodAutoscaler', 'PodDisruptionBudget', 'NetworkPolicy',
]);

function podSpecOf(o: any) {
  if (o.kind === 'Pod') return o.spec;
  if (o.kind === 'CronJob') return o.spec?.jobTemplate?.spec?.template?.spec;
  return o.spec?.template?.spec;
}

export interface CheckedManifest { yaml: string; objects: { kind: string; namespace: string; name: string }[] }

/** Parst und prüft ein (Multi-Doc-)Manifest; setzt fehlende Namespaces. Wirft bei Verstoß. */
export function checkManifest(text: string, defaultNs = 'default'): CheckedManifest {
  const docs = parseAllDocuments(text);
  for (const d of docs) if (d.errors.length) throw new Error(`YAML-Fehler: ${d.errors[0].message}`);
  const objs = docs.map(d => d.toJS()).filter(Boolean);
  if (!objs.length) throw new Error('Leeres Manifest');
  if (objs.length > 20) throw new Error('Maximal 20 Objekte pro Manifest');

  for (const o of objs) {
    if (typeof o !== 'object' || !o.apiVersion || !o.kind || !o.metadata?.name) throw new Error('Jedes Objekt braucht apiVersion, kind und metadata.name');
    if (!ALLOWED.has(o.kind)) throw new Error(`kind ${o.kind} ist nicht erlaubt`);
    o.metadata.namespace ??= defaultNs;
    const ns = o.metadata.namespace;
    if (config.namespaces.length && !config.namespaces.includes(ns)) throw new Error(`Namespace ${ns} ist nicht erlaubt`);
    const ps = podSpecOf(o);
    if (ps) {
      if (ps.hostNetwork || ps.hostPID || ps.hostIPC) throw new Error('hostNetwork/hostPID/hostIPC sind nicht erlaubt');
      if ((ps.volumes ?? []).some((v: any) => v.hostPath)) throw new Error('hostPath-Volumes sind nicht erlaubt');
      for (const c of [...(ps.containers ?? []), ...(ps.initContainers ?? [])])
        if (c.securityContext?.privileged) throw new Error(`Container ${c.name} darf nicht privileged sein`);
    }
  }
  return {
    yaml: objs.map(o => stringify(o)).join('---\n'),
    objects: objs.map(o => ({ kind: o.kind, namespace: o.metadata.namespace, name: o.metadata.name })),
  };
}
