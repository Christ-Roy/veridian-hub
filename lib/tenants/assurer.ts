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

type Db = Pick<PrismaClient, 'tenant'>;

/** Deux appels qui se croisent pour un même compte n'en créent qu'un : le second attend le premier (verrou Postgres, rendu en fin de transaction). */
export async function assurerTenantHub(db: Db & Partial<Pick<PrismaClient, '$transaction'>>, email: string, userId: string, nom?: string | null): Promise<string> {
  const deja = await vivant(db, userId);
  if (deja) return deja;
  if (!db.$transaction) return chercherOuCreer(db, email, userId, nom);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant:${userId}`}, 0))`;
    return chercherOuCreer(tx, email, userId, nom);
  });
}

const vivant = async (db: Db, userId: string): Promise<string | null> =>
  (await db.tenant.findFirst({ where: { userId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id ?? null;

async function chercherOuCreer(db: Db, email: string, userId: string, nom?: string | null): Promise<string> {
  const existant = await vivant(db, userId);
  if (existant) return existant;
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
