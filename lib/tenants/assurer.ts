/**
 * Le tenant Hub d'un compte, créé s'il manque. Appelé AVANT de provisionner une app : Notifuse et
 * Prospection tournaient en parallèle, chacun « cherche, sinon crée », et pouvaient créer deux
 * tenants pour un même compte ; Prospection ne recevait pas non plus l'id Hub (tenant_id du JWT MCP).
 * La création d'un espace (CRM, Academy) l'appelle aussi : un compte sans Notifuse ni Prospection
 * (client « CRM seul », comptes du staging) n'avait pas de tenant, donc pas d'espace (22/11).
 * Un tenant supprimé n'est jamais repris.
 */
import type { PrismaClient } from '@prisma/client';

function slugify(email: string): string {
  return email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export async function assurerTenantHub(
  db: Pick<PrismaClient, 'tenant'>,
  email: string,
  userId: string,
  nom?: string | null,
): Promise<string> {
  const existant = await db.tenant.findFirst({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (existant) return existant.id;
  const slug = slugify(email);
  const slugPris = await db.tenant.findUnique({ where: { slug }, select: { id: true } });
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 15);
  const cree = await db.tenant.create({
    data: {
      userId,
      name: nom ?? email.split('@')[0],
      slug: slugPris ? `${slug}-${Math.random().toString(36).slice(2, 7)}` : slug,
      status: 'active',
      provisionedAt: new Date(),
      trialEndsAt,
    },
    select: { id: true },
  });
  return cree.id;
}
