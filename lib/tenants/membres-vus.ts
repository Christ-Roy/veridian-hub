/** Les membres des espaces dont ce compte est propriétaire, pour qu'il voie chaque arrivée (VER-245). */
import type { PrismaClient } from '@prisma/client';

export async function membresVus(db: Pick<PrismaClient, 'user' | 'tenant' | 'tenantMember'>, userId: string) {
  const u = await db.user.findUnique({ where: { id: userId }, select: { supabaseUserId: true } });
  if (!u?.supabaseUserId) return [];
  const tenants = await db.tenant.findMany({ where: { userId: u.supabaseUserId, deletedAt: null }, select: { id: true, name: true } });
  if (tenants.length === 0) return [];
  const lignes = await db.tenantMember.findMany({ where: { tenantId: { in: tenants.map((t) => t.id) }, deletedAt: null }, orderBy: { joinedAt: 'desc' } });
  if (lignes.length === 0) return [];
  const comptes = await db.user.findMany({ where: { supabaseUserId: { in: lignes.map((l) => l.userId) } }, select: { supabaseUserId: true, email: true } });
  return lignes.map((l) => ({
    espace: tenants.find((t) => t.id === l.tenantId)!.name,
    email: comptes.find((c) => c.supabaseUserId === l.userId)?.email ?? 'compte inconnu',
    role: l.role,
    origine: l.origine,
    depuis: l.joinedAt,
  }));
}
