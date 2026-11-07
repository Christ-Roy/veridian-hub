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
 * Retire les liaisons OAuth posées sur ce compte avant qu'il soit prouvé (D1). Un tenant Entra
 * ou un compte Google non vérifié a pu rattacher le compte avant la preuve : la preuve, venue
 * d'ailleurs, ne doit pas laisser ce passage ouvert. `gardeProvider` garde la liaison du
 * fournisseur qui vient de prouver. Renvoie le nombre de lignes retirées.
 */
export async function retirerLiensNonProuves(
  prisma: Pick<PrismaClient, 'account'>,
  userId: string,
  gardeProvider?: string,
): Promise<number> {
  const garde = ['credentials', ...(gardeProvider ? [gardeProvider] : [])];
  const { count } = await prisma.account.deleteMany({
    where: { userId, provider: { notIn: garde } },
  });
  return count;
}

/**
 * Enregistre une preuve fournisseur. Si l'adresse n'était pas prouvée, les liaisons OAuth
 * posées avant la preuve sont retirées (D1) ; si un mot de passe existe, il est annulé. Dans
 * les deux cas, les sessions déjà émises deviennent invalides.
 */
export async function applyProviderEmailProof(
  prisma: ProofPrisma,
  userId: string,
  provider?: string,
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
  const liensRetires = await retirerLiensNonProuves(prisma, userId, provider);
  await prisma.user.update({
    where: { id: userId },
    data: {
      emailVerified: now,
      ...(count > 0 || liensRetires > 0 ? { sessionsValidAfter: now } : {}),
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

/**
 * Lecture serveur du champ `email_proven` envoyé aux apps (CONTRAT-HUB §3.8) : vrai
 * seulement si `emailVerified` est posé en base. Une impersonation admin passe la garde
 * mais n'atteste rien. En cas de doute (user absent, base en erreur) : pas d'attestation.
 */
export async function isEmailProvenInDb(
  prisma: Pick<PrismaClient, 'user'>,
  hubUserId: string,
): Promise<boolean> {
  try {
    const row = await prisma.user.findUnique({
      where: { supabaseUserId: hubUserId },
      select: { emailVerified: true },
    });
    return Boolean(row?.emailVerified);
  } catch {
    return false;
  }
}
