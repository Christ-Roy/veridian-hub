/**
 * Une personne connectée par ses propres moyens passe par le fournisseur de son organisation : sa session reste la sienne, avec toutes ses organisations, et
 * gagne celle-ci (VER-261). Premier passage : son identité se relie, preuve récente exigée. Aucune session ne naît du fournisseur seul.
 */
import type { PrismaClient } from '@prisma/client';

import { unstable_update } from '@/auth';

import { fournisseur } from './identite';
import type { IdpPret } from './idp';
import { relierParPersonne, type RefusLiaison } from './liaison';
import { noterPassage } from './obligation';
import type { Identite } from './oidc';
import { emettreTicket } from './ticket';

type Personne = { id: string; email: string; emailVerified: Date | null; supabaseUserId: string | null };
type Db = PrismaClient;

export const dejaReliee = async (db: Pick<Db, 'account'>, i: Pick<IdpPret, 'id'>, userId: string): Promise<boolean> =>
  (await db.account.findFirst({ where: { userId, provider: fournisseur(i) }, select: { id: true } })) !== null;

/** `recente` : elle vient de se connecter elle-même. Sans cela, une identité déjà reliée est reconnue, une nouvelle ne se relie pas. */
export async function prouver(db: Db, i: IdpPret, x: Identite, u: Personne, recente: boolean): Promise<{ ok: true } | { refus: RefusLiaison | 'preuve_ancienne' }> {
  const lien = await db.account.findUnique({ where: { provider_providerAccountId: { provider: fournisseur(i), providerAccountId: x.sub } }, select: { userId: true } });
  if (!lien && !recente) return { refus: 'preuve_ancienne' };
  // Relu même si le lien existe : toujours membre, toujours son `sub` à elle.
  const r = await relierParPersonne(db, i, x, u);
  if ('refus' in r) return r;
  await marquer(db, i, { id: u.id, hubUserId: u.supabaseUserId! });
  return { ok: true };
}

/** La session courante porte désormais ce passage. Le ticket ne quitte pas le serveur. */
export async function marquer(db: Db, i: Pick<IdpPret, 'id' | 'tenantId'>, u: { id: string; hubUserId: string }): Promise<void> {
  await noterPassage(db, i, u.hubUserId);
  await unstable_update({ preuve: await emettreTicket(db, u.id, i.tenantId) } as never);
}
