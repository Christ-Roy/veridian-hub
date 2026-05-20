/**
 * Callback `signIn` extrait de `auth.ts` — rendu testable unitairement.
 *
 * Couvre tous les scénarios OAuth A-F documentés dans
 * `todo/2026-05-20-oauth-scenarios-coverage.md` + le hook MFA email.
 *
 * Contrat de retour Auth.js v5 :
 *   - `true`   → autorise la session
 *   - `false`  → bloque la session
 *   - `string` (path) → redirige vers le path donné (pre-session MFA)
 */

import type { PrismaClient } from '@prisma/client';

type SignInUser = {
  id?: string | null;
  email?: string | null;
  name?: string | null;
  image?: string | null;
};

export type SignInDeps = {
  /** Prisma client minimal (mockable) */
  prisma: Pick<PrismaClient, 'user'>;
  /** Sender MFA email (mockable) */
  issueAndSendMfaCode: (input: { id: string; email: string }) => Promise<unknown>;
  /** Logger (mockable) — par défaut console */
  logger?: { error: (...args: unknown[]) => void };
};

/**
 * Factorise le callback `signIn` Auth.js v5 avec ses dépendances injectées.
 * Utilisé par `auth.ts` (avec les deps réelles) et par les tests unitaires
 * (avec mocks).
 */
export function createSignInCallback({ prisma, issueAndSendMfaCode, logger = console }: SignInDeps) {
  return async function signIn({ user }: { user: SignInUser }): Promise<boolean | string> {
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
      // Premier login OAuth ou Credentials → le PrismaAdapter va créer le
      // user. On laisse passer (pas de MFA au tout premier login).
      // Scénarios A (signup Google) et B (signup Microsoft) du catalogue.
      return true;
    }

    if (dbUser.mfaEnabled) {
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
    // Le link account ↔ user est géré par le PrismaAdapter via
    // `allowDangerousEmailAccountLinking: true` côté provider.
    return true;
  };
}
