/**
 * Une app réservée, cochée pour une organisation, s'ouvre à ses membres VIVANTS (parente, 25/11, option A) : l'organisation entre dans l'app avec
 * ses gens, sans activer chacun. Lu à chaque fois, jamais recopié : un retrait, une suspension, une case décochée referment aussitôt. L'app garde
 * ses propres droits. Academy garde sa réserve (Robert, 22/11) : elle n'est pas ici.
 */
import type { PrismaClient } from '@prisma/client';

import type { GatedAppKey } from './index';

/** Clé du module d'organisation → clé de l'app réservée. */
const OUVERTES_PAR_ORGANISATION: Record<string, GatedAppKey> = { crm: 'twenty' };
type Db = Pick<PrismaClient, 'tenant' | 'tenantMember' | 'organisation'>;

/** `tenantId` : seulement par CETTE organisation. Une lecture ratée n'ouvre rien. */
export async function appsParOrganisation(db: Db, hubUserId: string, tenantId?: string): Promise<Set<GatedAppKey>> {
  try {
    const membre = await db.tenantMember.findMany({ where: { userId: hubUserId, deletedAt: null, ...(tenantId ? { tenantId } : {}) }, select: { tenantId: true } });
    const vivants = await db.tenant.findMany({ where: { deletedAt: null, status: { notIn: ['suspended', 'deleted'] }, OR: [{ userId: hubUserId }, { id: { in: membre.map((m) => m.tenantId) } }], ...(tenantId ? { id: tenantId } : {}) }, select: { id: true } });
    if (vivants.length === 0) return new Set();
    const orgs = await db.organisation.findMany({ where: { tenantId: { in: vivants.map((t) => t.id) } }, select: { modules: true } });
    return new Set(orgs.flatMap((o) => o.modules).flatMap((m) => OUVERTES_PAR_ORGANISATION[m] ?? []));
  } catch {
    return new Set();
  }
}
