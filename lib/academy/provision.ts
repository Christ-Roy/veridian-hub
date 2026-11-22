/**
 * Academy (e-learning, `academy.app.veridian.site`) : espace par utilisateur, même contrat que le CRM
 * (`lib/apps/espace-app.ts`). App réservée : elle ne s'ouvre qu'aux comptes activés dans `tenant_apps`
 * (`hub app-access <email> --app academy --enabled true`), demande de Robert du 22/11.
 */
import type { PrismaClient } from '@prisma/client';

import { ensureAppWorkspace, ESPACE_APPS, type EspaceProvisionResult } from '@/lib/apps/espace-app';

export function ensureAcademyWorkspace(
  db: Pick<PrismaClient, 'tenant' | 'tenantApp' | 'tenantTrial' | 'subscription'>,
  user: { hubUserId: string; email: string; name?: string | null },
  opts: { actorEmail?: string | null; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<EspaceProvisionResult> {
  return ensureAppWorkspace(ESPACE_APPS.academy, db, user, opts);
}
