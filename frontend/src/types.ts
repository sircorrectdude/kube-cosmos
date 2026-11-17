// Spiegelt backend/src/k8s.ts
export type Kind = 'Namespace' | 'Node' | 'Pod' | 'Deployment' | 'Service' | 'External' | 'HPA' | 'Ingress' | 'PVC';

export interface Res {
  uid: string;
  kind: Kind;
  name: string;
  namespace?: string;
  status?: string;
  labels?: Record<string, string>;
  nodeName?: string;
  selector?: Record<string, string>;
  replicas?: number;
  readyReplicas?: number;
  restarts?: number;
  probes?: Record<string, 'ok' | 'wait' | 'fail'>;
  unschedulable?: boolean;
  cpuCores?: number;
  memGi?: number;
  target?: string;
  minReplicas?: number;
  maxReplicas?: number;
  currentReplicas?: number;
  desiredReplicas?: number;
  rules?: { host?: string; path?: string; service?: string; port?: string | number }[];
  ingressClass?: string;
  pvcs?: string[];
  storageClass?: string;
  capacity?: string;
  accessModes?: string[];
  volumeName?: string;
}

/** Optional aus Prometheus (siehe backend/src/metrics.ts) */
export interface PodMetrics { cpu: number; cpuRel?: number; mem: number; memRel?: number }
export interface NodeMetrics { cpu: number; mem: number }
export interface VolumeMetrics { used: number; capacity: number }

export interface Flow {
  src: string;
  dst: string;
  type: 'request' | 'response';
  verdict: 'forwarded' | 'dropped' | 'error';
  protocol?: string;
  httpMethod?: string;
  httpStatus?: number;
  ext?: { entry: string; agent: string; ip: string; path: string };
}

/** Verbindungsstatus einer Datenquelle (Backend: status.ts) */
export interface ServiceStatus { id: string; label: string; state: 'ok' | 'warn' | 'error' | 'off' | 'unknown'; detail?: string; since: number }

export interface KEvent {
  uid: string;
  namespace?: string;
  type?: string;
  reason?: string;
  message?: string;
  object?: string;
  time?: string;
}
