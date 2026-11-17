// Platzhalter für Auth, Policy und Audit. Funktionalität folgt in Schritt 5.
import type { IncomingMessage } from 'node:http';

export type Role = 'viewer' | 'operator' | 'approver';
export interface Principal { user: string; roles: Role[] }

/** local/readonly: anonymer Nutzer. production: OIDC (TODO). */
export function authenticate(_req: IncomingMessage): Principal | null {
  return { user: 'local', roles: ['viewer', 'operator', 'approver'] };
}

/** Befehls-Policy (TODO). */
export function checkPolicy(_p: Principal, _command: string): { allowed: boolean; reason?: string } {
  return { allowed: true };
}

/** Audit-Log als strukturiertes JSON (TODO: persistieren). */
export function audit(_entry: Record<string, unknown>) {}
