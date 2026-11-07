/**
 * Révocation des sessions JWT du Hub. Un JWT ne se retire pas : on refuse ceux dont la connexion
 * réelle (`authAt`) précède `users.sessions_valid_after`, et ceux d'un compte supprimé. Jamais `iat` :
 * Auth.js le réécrit à chaque lecture de session, y compris dans le middleware, qui ne lit pas la
 * base. Un vieux cookie y gagnait un `iat` neuf et survivait à la révocation (mesuré le 07/11).
 * Fichier sans dépendance à `auth.ts`, qui l'importe.
 */

import type { PrismaClient } from '@prisma/client';

type Jeton = { uid?: unknown; authAt?: unknown; impersonated?: unknown };

export async function isSessionRevoked(
  prisma: Pick<PrismaClient, 'user'>,
  token: Jeton,
): Promise<boolean> {
  if (typeof token.uid !== 'string') return false;
  let row: { sessionsValidAfter: Date | null } | null;
  try {
    row = await prisma.user.findUnique({
      where: { id: token.uid },
      select: { sessionsValidAfter: true },
    });
  } catch (err) {
    // Base injoignable : le Hub ne sert de toute façon plus rien. On ne déconnecte personne
    // sur une panne passagère.
    console.error('[session-revocation] lecture impossible', err);
    return false;
  }
  if (!row) return true;
  if (!row.sessionsValidAfter || token.impersonated === true) return false;
  // Jeton d'avant `authAt` : sa date réelle est inconnue, il tombe dès qu'une révocation existe.
  const authAt = typeof token.authAt === 'number' ? token.authAt : 0;
  return authAt < Math.floor(row.sessionsValidAfter.getTime() / 1000);
}

/** Coupe toutes les sessions d'un compte, ici et dans les apps. */
export async function revokeAllSessions(
  prisma: Pick<PrismaClient, 'user'>,
  user: { id: string; supabaseUserId: string | null },
): Promise<void> {
  await prisma.user.update({
    where: { id: user.id },
    data: { sessionsValidAfter: new Date() },
  });
  if (user.supabaseUserId) {
    const { pushUserToApps } = await import('@/lib/identity/push-user');
    await pushUserToApps({ hubUserId: user.supabaseUserId, revokeSessions: true });
  }
}
