/** Une organisation marquée de test au Hub : la seule que `<cible>@test` (actions) ou `<paire>@test` (événements) ouvre. Jamais une forme d'adresse (lib/tenants/marque-test.ts). */
import type { PrismaClient } from '@prisma/client';

import { estDeTest } from '@/lib/tenants/marque-test';

export async function organisationDeTest(db: Pick<PrismaClient, 'tenant'>, tenantId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!`${env.DELEGATION_CIBLES ?? ''},${env.DELEGATION_EVENEMENTS ?? ''}`.includes('@test')) return false;
  const t = await db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { metadata: true } });
  return estDeTest(t?.metadata);
}
