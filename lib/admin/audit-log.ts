/**
 * Audit log helper — append une row dans `hub_app.audit_log`.
 *
 * Conçu pour être appelé depuis les routes admin (API admin provisioning,
 * link-app, unlink-app) après chaque action réussie. Best-effort : un
 * échec d'audit ne doit JAMAIS faire échouer l'action métier — on log
 * l'erreur dans la console mais on swallow l'exception.
 *
 * Pour récupérer l'identité de l'actor depuis une request admin :
 *  - session Auth.js → `admin:<email>`
 *  - x-admin-secret  → `token:HUB_ADMIN_TOKEN`
 *  - x-hub-admin-token → `token:HUB_ADMIN_TOKEN` (alias)
 */

import type { PrismaClient } from '@prisma/client';

export type AuditEvent = {
  action: string;
  actor: string;
  targetType?: 'user' | 'tenant' | 'app_link';
  targetId?: string;
  payload?: Record<string, unknown>;
};

export async function writeAuditLog(
  prisma: PrismaClient,
  event: AuditEvent
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: event.action,
        actor: event.actor,
        targetType: event.targetType,
        targetId: event.targetId,
        payload: (event.payload ?? null) as never,
      },
    });
  } catch (err) {
    // Best-effort : on ne casse jamais l'action métier sur un échec d'audit.
    console.error(
      JSON.stringify({
        tag: '[audit-log-failed]',
        level: 'error',
        action: event.action,
        actor: event.actor,
        error: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      })
    );
  }
}

/**
 * Détermine l'actor à partir des headers d'une request admin.
 * Précédence : session Auth.js (passée en argument) > x-admin-secret > x-hub-admin-token.
 */
export function resolveActor(
  headers: Headers,
  sessionEmail: string | null | undefined
): string {
  if (sessionEmail) return `admin:${sessionEmail}`;
  if (headers.get('x-admin-secret')) return 'token:ADMIN_SECRET';
  if (headers.get('x-hub-admin-token')) return 'token:HUB_ADMIN_TOKEN';
  return 'unknown';
}
