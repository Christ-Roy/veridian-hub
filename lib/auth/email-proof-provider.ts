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

/** Le lien OAuth qui vient de prouver l'adresse : gardé, et lui seul. */
export type LienProuve = { provider: string; providerAccountId?: string | null };

/**
 * Retire les liaisons OAuth posées sur ce compte avant qu'il soit prouvé (D1, M2 de
 * SSO-ORGANISATIONS.md : pré-prise de compte). Un tenant Entra ou un compte Google non vérifié a pu
 * créer ou rattacher le compte avant la preuve : la preuve ne doit pas laisser ce passage ouvert.
 * `garde` : le lien qui vient de prouver. Avec son `providerAccountId`, seul CE compte du
 * fournisseur est gardé (23/11 : garder tout le fournisseur laissait le lien Google non vérifié
 * d'un attaquant à côté du vrai). Le mot de passe (`credentials`) est traité à part.
 * Renvoie le nombre de lignes retirées.
 */
export async function retirerLiensNonProuves(
  prisma: Pick<PrismaClient, 'account'>,
  userId: string,
  garde?: string | LienProuve,
): Promise<number> {
  const g = typeof garde === 'string' ? { provider: garde } : garde;
  const where = g?.providerAccountId
    ? { userId, provider: { not: 'credentials' }, NOT: { provider: g.provider, providerAccountId: g.providerAccountId } }
    : { userId, provider: { notIn: ['credentials', ...(g ? [g.provider] : [])] } };
  const { count } = await prisma.account.deleteMany({ where });
  return count;
}

/**
 * Enregistre une preuve fournisseur sur un compte qui n'en avait pas : les liaisons OAuth posées avant
 * la preuve sont retirées (sauf celle qui prouve), un mot de passe non prouvé est annulé, et les
 * sessions émises avant tombent.
 * `sessions` : `toujours` quand l'appel précède l'émission de la session (callback `signIn`, One Tap) :
 * la session qui naît reste valide (même seconde). `si_retrait` quand la session vient d'être émise
 * (event `signIn` d'un compte neuf), pour ne pas la révoquer elle-même.
 */
export async function applyProviderEmailProof(
  prisma: ProofPrisma,
  userId: string,
  provider?: string,
  options: { providerAccountId?: string | null; sessions?: 'toujours' | 'si_retrait' } = {},
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
  const liensRetires = await retirerLiensNonProuves(
    prisma,
    userId,
    provider ? { provider, providerAccountId: options.providerAccountId } : undefined,
  );
  const invalider = (options.sessions ?? 'si_retrait') === 'toujours' || count > 0 || liensRetires > 0;
  await prisma.user.update({
    where: { id: userId },
    data: { emailVerified: now, ...(invalider ? { sessionsValidAfter: now } : {}) },
  });
  if (count > 0 || liensRetires > 0) {
    console.warn(
      JSON.stringify({
        tag: '[email-proof]',
        level: 'warn',
        msg: 'première preuve : accès non prouvés retirés',
        userId,
        mot_de_passe: count,
        liens_oauth: liensRetires,
        ts: now.toISOString(),
      }),
    );
  }
}

/**
 * Preuve par mail (lien de preuve, invitation acceptée) sur un compte non prouvé : liaisons OAuth posées
 * avant retirées, et les sessions avec si quelque chose a été retiré. Le mot de passe reste : c'est celui
 * de la personne qui vient de prouver. Renvoie le nombre de liens retirés.
 */
export async function prouverParMail(prisma: ProofPrisma, userId: string): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerified: true } });
  if (!user || user.emailVerified) return 0;
  const now = new Date();
  const retires = await retirerLiensNonProuves(prisma, userId);
  await prisma.user.update({
    where: { id: userId },
    data: { emailVerified: now, ...(retires > 0 ? { sessionsValidAfter: now } : {}) },
  });
  return retires;
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
