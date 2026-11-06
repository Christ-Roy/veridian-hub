/**
 * Preuves apportées par un fournisseur OAuth. Fichier à part de `email-proof.ts` :
 * `auth.ts` l'importe, et `email-proof.ts` importe `auth.ts`.
 */

import type { PrismaClient } from '@prisma/client';

type ProofPrisma = Pick<PrismaClient, 'user' | 'account'>;

/** Le fournisseur certifie-t-il que cette personne contrôle cette adresse ? */
export function providerProvesEmail(
  account: { provider?: string | null } | null | undefined,
  profile: Record<string, unknown> | null | undefined,
  email: string | null | undefined,
): boolean {
  const provider = account?.provider;
  if (!provider || !email) return false;
  // Le provider One Tap vérifie `email_verified` avant d'autoriser la connexion.
  if (provider === 'google-one-tap') return true;
  const profileEmail = typeof profile?.email === 'string' ? profile.email.toLowerCase() : null;
  if (profileEmail !== email.toLowerCase()) return false;
  if (provider === 'google') return profile?.email_verified === true;
  // Entra multi-tenant : `email` est modifiable par l'admin d'un tenant quelconque.
  // Seul le domaine vérifié (`xms_edov`) vaut preuve.
  if (provider === 'microsoft-entra-id') {
    return profile?.xms_edov === true || profile?.xms_edov === '1';
  }
  if (provider === 'mock-oauth') return profile?.email_verified === true;
  return false;
}

/**
 * Enregistre une preuve fournisseur. Si l'adresse n'était pas prouvée et qu'un mot
 * de passe existe, il est annulé et les sessions déjà émises deviennent invalides.
 */
export async function applyProviderEmailProof(
  prisma: ProofPrisma,
  userId: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerified: true },
  });
  if (!user || user.emailVerified) return;

  const now = new Date();
  const { count } = await prisma.account.deleteMany({
    where: { userId, provider: 'credentials' },
  });
  await prisma.user.update({
    where: { id: userId },
    data: {
      emailVerified: now,
      ...(count > 0 ? { sessionsValidAfter: now } : {}),
    },
  });
  if (count > 0) {
    console.warn(
      JSON.stringify({
        tag: '[email-proof]',
        level: 'warn',
        msg: 'mot de passe non prouvé annulé par une connexion OAuth',
        userId,
        ts: now.toISOString(),
      }),
    );
  }
}
