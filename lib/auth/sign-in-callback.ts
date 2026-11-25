/**
 * Callback `signIn` extrait de `auth.ts` — rendu testable unitairement.
 *
 * Couvre tous les scénarios OAuth A-F documentés dans
 * `todo/2026-05-20-oauth-scenarios-coverage.md` + le hook MFA email.
 *
 * Contrat de retour Auth.js v5 :
 *   - `true`   → autorise la session
 *   - `false`  → bloque la session
 *   - `string` (path) → redirige vers le path donné (pre-session MFA, ou refus de liaison)
 *
 * Liaison OAuth (D1) : un fournisseur ne rattache un compte EXISTANT à son adresse que si
 * l'adresse est prouvée (`providerProvesEmail`), ou si cette ligne `account` est déjà liée
 * à ce compte. Sinon, refus : un tenant Entra peut poser n'importe quelle adresse dans
 * `email`, et un compte Google peut avoir une adresse non vérifiée.
 */

import type { PrismaClient } from '@prisma/client';

import { normaliserEmail } from '@/lib/auth/email-normalize';
import { providerProvesEmail } from '@/lib/auth/email-proof-provider';

/** Page qui explique en français pourquoi la connexion OAuth est refusée (D1). */
export const LIAISON_REFUSEE_PATH = '/auth/liaison-refusee';

/** Page qui explique qu'un compte neuf exige une adresse prouvée, et mène à l'inscription par adresse (M2). */
export const PREUVE_REQUISE_PATH = '/auth/preuve-requise';

/** Fournisseurs OAuth dont la ligne `account` peut être liée à un compte existant. */
const FOURNISSEURS_OAUTH_LIENS = new Set(['google', 'microsoft-entra-id', 'mock-oauth']);

/** Page qui explique qu'on se connecte par l'adresse principale (S1b). */
export const ADRESSE_SECONDAIRE_PATH = '/auth/adresse-secondaire';

type SignInUser = {
  id?: string | null;
  email?: string | null;
  name?: string | null;
  image?: string | null;
};

export type SignInDeps = {
  /** Prisma client minimal (mockable) */
  prisma: Pick<PrismaClient, 'user' | 'account'> & Partial<Pick<PrismaClient, 'userEmail'>>;
  /** Sender MFA email (mockable) */
  issueAndSendMfaCode: (input: { id: string; email: string }) => Promise<unknown>;
  /** Enregistre une preuve fournisseur (annule un mot de passe non prouvé). */
  applyProviderEmailProof?: (
    prisma: never,
    userId: string,
    provider?: string,
    options?: { providerAccountId?: string | null; sessions?: 'toujours' | 'si_retrait' },
  ) => Promise<void>;
  /** Logger (mockable) — par défaut console */
  logger?: { error: (...args: unknown[]) => void };
};

/**
 * Factorise le callback `signIn` Auth.js v5 avec ses dépendances injectées.
 * Utilisé par `auth.ts` (avec les deps réelles) et par les tests unitaires
 * (avec mocks).
 */
export function createSignInCallback({
  prisma,
  issueAndSendMfaCode,
  applyProviderEmailProof,
  logger = console,
}: SignInDeps) {
  return async function signIn({
    user,
    account,
    profile,
  }: {
    user: SignInUser;
    account?: { provider?: string | null; providerAccountId?: string | null } | null;
    profile?: Record<string, unknown> | null;
  }): Promise<boolean | string> {
    if (!user.email) {
      // Aucun provider ne retourne un user sans email en pratique (les 3
      // providers Veridian — Google, Microsoft, Credentials — exigent email).
      // Mais on durcit le flow par défense en profondeur.
      return false;
    }

    const dbUser = await prisma.user.findUnique({
      where: { email: user.email },
      select: { id: true, email: true, mfaEnabled: true },
    });

    if (!dbUser) {
      // M2 (SSO-ORGANISATIONS.md, 23/11) : pas de compte NEUF sans adresse prouvée. Sinon, l'admin d'un
      // tenant Entra quelconque (ou un compte Google à adresse non vérifiée) crée le compte d'un futur
      // client et garde la main quand le vrai titulaire arrive. Repli : l'inscription par adresse, dont
      // le lien de preuve part dans la boîte (PREUVE_REQUISE_PATH).
      const provider = account?.provider ?? null;
      if (provider && FOURNISSEURS_OAUTH_LIENS.has(provider) && !providerProvesEmail(account, profile, user.email)) {
        logger.error('[auth] création de compte refusée : adresse non prouvée par le fournisseur', { provider });
        return PREUVE_REQUISE_PATH;
      }
      // L'adresse secondaire de quelqu'un (S1b) : ni compte neuf, ni entrée dans le sien. Il se connecte par son adresse principale.
      if (await prisma.userEmail?.findFirst({ where: { email: normaliserEmail(user.email), detacheeLe: null }, select: { userId: true } })) return ADRESSE_SECONDAIRE_PATH;
      // Fournisseur qui prouve (Google vérifié, Entra xms_edov, One Tap) : le PrismaAdapter crée le compte.
      return true;
    }

    // D1 : pas de preuve, et cette ligne OAuth n'est pas déjà liée à CE compte → refus.
    const provider = account?.provider ?? null;
    if (provider && FOURNISSEURS_OAUTH_LIENS.has(provider)) {
      const preuve = providerProvesEmail(account, profile, dbUser.email);
      if (!preuve) {
        const lien = account?.providerAccountId
          ? await prisma.account.findUnique({
              where: { provider_providerAccountId: { provider, providerAccountId: account.providerAccountId } },
              select: { userId: true },
            })
          : null;
        if (lien?.userId !== dbUser.id) {
          logger.error('[auth] liaison OAuth refusée : adresse non prouvée', { provider, userId: dbUser.id });
          return LIAISON_REFUSEE_PATH;
        }
      }
    }

    // Avant la pose du JWT : la session qui naît ici reste valide, celles d'avant non.
    if (applyProviderEmailProof && providerProvesEmail(account, profile, dbUser.email)) {
      // Avant l'émission de la session : celles d'avant tombent toutes, celle-ci naît valide (M2).
      await applyProviderEmailProof(prisma as never, dbUser.id, provider ?? undefined, {
        providerAccountId: account?.providerAccountId ?? null,
        sessions: 'toujours',
      });
    }

    if (dbUser.mfaEnabled) {
      // D3 : le mot de passe d'un compte à double vérification passe par `/api/auth/mfa/start`,
      // qui pose le cookie d'étape 1. Un signIn credentials direct n'a pas ce cookie : il ne doit
      // ni envoyer de code, ni laisser croire qu'une session va naître.
      if (provider === 'credentials') return false;
      try {
        await issueAndSendMfaCode({ id: dbUser.id, email: dbUser.email });
      } catch (err) {
        logger.error('[auth] failed to issue MFA code', err);
        return false;
      }
      // Redirige vers la page de saisie du code MFA email.
      // Pattern Auth.js v5 : un path comme valeur de retour = "allow with redirect".
      return `/auth/mfa?uid=${encodeURIComponent(dbUser.id)}`;
    }

    // User existant sans MFA → login direct.
    // Couvre scénarios C/D/E/F du catalogue (link OAuth ↔ user existant).
    // Le link account ↔ user est géré par le PrismaAdapter, mais seulement après la garde D1 ci-dessus.
    return true;
  };
}
