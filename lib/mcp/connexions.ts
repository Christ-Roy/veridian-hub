/** Connexions IA actives d'un compte (une famille de jetons = une connexion), pour Réglages > Sécurité. */
import type { PrismaClient } from '@prisma/client';

import { revoquerFamille } from './oauth';

type Db = Pick<PrismaClient, 'oauthToken' | 'oauthClient' | 'user'>;

export type ConnexionIa = { id: string; client: string; depuis: Date; derniereUtilisation: Date | null };

export async function connexionsActives(db: Db, hubUserId: string): Promise<ConnexionIa[]> {
  const jetons = await db.oauthToken.findMany({
    where: { hubUserId, kind: 'refresh', revokedAt: null, usedAt: null, expiresAt: { gt: new Date() } },
    select: { familyId: true, clientId: true, createdAt: true },
  });
  const u = await db.user.findUnique({ where: { supabaseUserId: hubUserId }, select: { sessionsValidAfter: true } });
  if (jetons.length === 0) return [];
  const clients = await db.oauthClient.findMany({ where: { clientId: { in: jetons.map((j) => j.clientId) } }, select: { clientId: true, name: true, lastUsedAt: true } });
  const out: ConnexionIa[] = [];
  for (const j of jetons) {
    const premier = await db.oauthToken.findFirst({ where: { familyId: j.familyId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    const depuis = premier?.createdAt ?? j.createdAt;
    // Coupée par « se déconnecter partout » : n'est plus une connexion active.
    if (u?.sessionsValidAfter && u.sessionsValidAfter > depuis) continue;
    const c = clients.find((x) => x.clientId === j.clientId);
    out.push({ id: j.familyId, client: c?.name ?? 'Client IA', depuis, derniereUtilisation: c?.lastUsedAt ?? null });
  }
  return out.sort((a, b) => b.depuis.getTime() - a.depuis.getTime());
}

/** Coupe une connexion du compte. Une connexion d'un autre compte n'est jamais touchée. */
export async function couperConnexion(db: Db, hubUserId: string, familyId: string): Promise<boolean> {
  const t = await db.oauthToken.findFirst({ where: { familyId, hubUserId }, select: { id: true } });
  if (!t) return false;
  await revoquerFamille(db as never, familyId);
  return true;
}
