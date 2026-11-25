/**
 * Quelqu'un qui n'est QUE membre d'une organisation (VER-261) : un salarié, sans espace à lui. Il voit les apps de son organisation, et rien ne lui crée
 * un espace personnel par mégarde (premier clic, IA branchée) : il se retrouverait dans un espace vide, et sa connexion d'organisation lui serait refusée.
 */
import type { PrismaClient } from '@prisma/client';

export type OrganisationSeule = { id: string; nom: string; modules: string[] };
type Db = Pick<PrismaClient, 'tenant' | 'tenantMember' | 'organisation'>;

/** Ses organisations réglées, s'il n'a aucun espace à lui. Vide : un compte ordinaire. Une lecture ratée lève : on ne crée rien dans le doute. */
export async function organisationsSeules(db: Db, hubUserId: string): Promise<OrganisationSeule[]> {
  const membre = await db.tenantMember.findMany({ where: { userId: hubUserId, deletedAt: null }, select: { tenantId: true } });
  if (membre.length === 0) return [];
  const lus = await db.tenant.findMany({ where: { deletedAt: null, OR: [{ userId: hubUserId }, { id: { in: membre.map((m) => m.tenantId) }, status: { not: 'deleted' } }] }, select: { id: true, name: true, userId: true } });
  if (lus.some((t) => t.userId === hubUserId)) return [];
  const orgs = await db.organisation.findMany({ where: { tenantId: { in: lus.map((t) => t.id) }, type: 'organisation' }, select: { tenantId: true, nomAffiche: true, modules: true } });
  return orgs.map((o) => ({ id: o.tenantId, nom: o.nomAffiche ?? lus.find((t) => t.id === o.tenantId)?.name ?? '', modules: o.modules }));
}

export const membreSeul = async (db: Db, hubUserId: string): Promise<boolean> => (await organisationsSeules(db, hubUserId)).length > 0;
