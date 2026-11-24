/**
 * Organisation de test : un marquage posé par NOUS au Hub (route admin, audité), jamais une forme d'adresse que n'importe qui peut prendre
 * en s'inscrivant (la parente, 24/11). Il ouvre, pour cette organisation seule, ce qui est fermé aux clients (`ROLE_PORTE`,
 * `<cible>@test`), et il tombe de lui-même : une preuve finie ne laisse rien d'ouvert.
 */
import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { isTestAccount } from '@/lib/sync/test-residue';

export const DUREE_MARQUE_H = 24;

export function estDeTest(metadata: unknown, maintenant: Date = new Date()): boolean {
  const m = (metadata as { organisation_de_test?: { expire_le?: unknown } } | null | undefined)?.organisation_de_test;
  const fin = typeof m?.expire_le === 'string' ? Date.parse(m.expire_le) : NaN;
  return fin > maintenant.getTime() && fin <= maintenant.getTime() + DUREE_MARQUE_H * 3_600_000;
}

type Db = Pick<PrismaClient, 'tenant' | 'user' | 'auditLog'>;

/** Pose ou retire. Refusé si le propriétaire n'est pas un compte de batterie : un client ne se marque pas par erreur. */
export async function marquerTest(db: Db, d: { tenantId: string; poser: boolean; acteur: string }): Promise<{ expire_le: string | null } | { refus: 'tenant_introuvable' | 'compte_reel' }> {
  const t = await db.tenant.findFirst({ where: { id: d.tenantId, deletedAt: null }, select: { userId: true, metadata: true } });
  if (!t) return { refus: 'tenant_introuvable' };
  const u = await db.user.findFirst({ where: { supabaseUserId: t.userId }, select: { email: true } });
  if (d.poser && !(u && isTestAccount(u.email))) return { refus: 'compte_reel' };
  const { organisation_de_test: _avant, ...reste } = (t.metadata ?? {}) as Record<string, unknown>;
  const expire_le = d.poser ? new Date(Date.now() + DUREE_MARQUE_H * 3_600_000).toISOString() : null;
  const metadata = expire_le ? { ...reste, organisation_de_test: { expire_le, par: d.acteur } } : reste;
  await db.tenant.update({ where: { id: d.tenantId }, data: { metadata: metadata as never } });
  await writeAuditLog(db as PrismaClient, { action: expire_le ? 'tenant.test_marque' : 'tenant.test_retire', actor: d.acteur, targetType: 'tenant', targetId: d.tenantId, payload: { expire_le } });
  return { expire_le };
}
