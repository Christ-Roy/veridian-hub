/** Une organisation dont le propriétaire est un compte de test : la seule que `<cible>@test` ouvre. */
import type { PrismaClient } from '@prisma/client';

import { isTestAccount } from '@/lib/sync/test-residue';

export async function organisationDeTest(db: Pick<PrismaClient, 'tenant' | 'user'>, tenantId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!(env.DELEGATION_CIBLES ?? '').includes('@test')) return false;
  const t = await db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { userId: true } });
  const u = t ? await db.user.findFirst({ where: { supabaseUserId: t.userId }, select: { email: true } }) : null;
  return Boolean(u && isTestAccount(u.email));
}
