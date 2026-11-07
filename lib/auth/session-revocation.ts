/**
 * Révocation des sessions JWT du Hub. Un JWT ne se retire pas : on refuse ceux émis avant
 * `users.sessions_valid_after`, et ceux d'un compte supprimé. Fichier sans dépendance à `auth.ts`,
 * qui l'importe.
 */

import type { PrismaClient } from '@prisma/client';

type Jeton = { uid?: unknown; iat?: unknown; impersonated?: unknown };

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
  const iat = typeof token.iat === 'number' ? token.iat : 0;
  return iat < Math.floor(row.sessionsValidAfter.getTime() / 1000);
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
