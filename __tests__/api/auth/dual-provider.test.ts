/**
 * Tests unitaires Auth.js callbacks — scénarios F et I du catalogue OAuth
 * (`todo/2026-05-20-oauth-scenarios-coverage.md`).
 *
 * Ces deux scénarios concernent le comportement d'Auth.js v5 quand un même
 * humain se présente avec DEUX providers OAuth distincts (Google + Microsoft).
 * Ce que décide réellement le merge/split, c'est le PrismaAdapter, sur la
 * base de `user.email`. Le callback `signIn` extrait
 * (`lib/auth/sign-in-callback.ts`) ne fait que findUnique(email) puis
 * autorise/redirige selon MFA — il N'ALTÈRE PAS le linking.
 *
 * On teste donc ici le comportement OBSERVABLE du callback `signIn` face à
 * ces deux scénarios, qui sert de garde-fou anti-régression silencieuse :
 *
 *   F. User Google linké → tente login Microsoft, MÊME email.
 *      → Auth.js retrouve le user par email, ajoute une row `accounts`
 *        (2 providers, 1 userId). Le callback voit dbUser → autorise.
 *
 *   I. Email primaire Google ≠ Microsoft (alias).
 *      → Auth.js v5 ne merge PAS : 2 users distincts. Le callback voit
 *        l'email Microsoft comme inconnu en DB → autorise la création
 *        (PrismaAdapter créera un 2e user). Comportement accepté et
 *        documenté (pas de flow "Merge accounts" — décision ticket).
 *
 * Le linking effectif (insert dans `accounts`) appartient au PrismaAdapter
 * + `allowDangerousEmailAccountLinking` côté provider — non testable sans
 * vraie DB ; couvert par les tests d'intégration DB + E2E mock provider.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSignInCallback } from '@/lib/auth/sign-in-callback';

/**
 * Fabrique un callback signIn dont la DB ne connaît QUE les users passés
 * en argument (clé = email). Reproduit ce que voit le callback selon que
 * l'email présenté par le provider existe déjà ou non.
 */
function makeCallback(knownUsers: Array<{ id: string; email: string; mfaEnabled: boolean }>) {
  const byEmail = new Map(knownUsers.map((u) => [u.email, u]));
  const findUnique = vi.fn(async ({ where }: { where: { email: string } }) => {
    return byEmail.get(where.email) ?? null;
  });
  const issueAndSendMfaCode = vi.fn(async () => ({ ok: true }));
  const logger = { error: vi.fn() };
  const cb = createSignInCallback({
    prisma: { user: { findUnique } } as never,
    issueAndSendMfaCode,
    logger,
  });
  return { cb, findUnique, issueAndSendMfaCode };
}

describe('Scénario F — user Google linké tente login Microsoft (même email)', () => {
  it('autorise le login : le callback voit le user existant, ne bloque pas le link Microsoft', async () => {
    // L'humain a déjà un user Hub avec son compte Google linké.
    // Il revient via Microsoft, le provider Microsoft retourne le MÊME email.
    const existing = { id: 'u-dual', email: 'pro@veridian.site', mfaEnabled: false };
    const { cb, findUnique } = makeCallback([existing]);

    const result = await cb({ user: { email: 'pro@veridian.site' } });

    // Le callback retrouve le user par email → autorise. Le PrismaAdapter
    // ajoutera la row accounts Microsoft (2 rows, 1 userId) grâce à
    // allowDangerousEmailAccountLinking côté provider Microsoft.
    expect(result).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: 'pro@veridian.site' },
      select: { id: true, email: true, mfaEnabled: true },
    });
  });

  it('user dual-provider avec MFA activé → redirige vers /auth/mfa (le 2e provider ne bypasse pas la MFA)', async () => {
    // Garde-fou sécu : ajouter un 2e provider ne doit JAMAIS contourner la
    // MFA email du user. Le callback redirige vers la saisie du code.
    const existing = { id: 'u-dual-mfa', email: 'secured@veridian.site', mfaEnabled: true };
    const { cb, issueAndSendMfaCode } = makeCallback([existing]);

    const result = await cb({ user: { email: 'secured@veridian.site' } });

    expect(result).toBe('/auth/mfa?uid=u-dual-mfa');
    expect(issueAndSendMfaCode).toHaveBeenCalledWith({
      id: 'u-dual-mfa',
      email: 'secured@veridian.site',
    });
  });

  it('re-login via le MÊME provider après linking est idempotent (autorise)', async () => {
    // Après que F a créé le 2e account, re-login via l'un OU l'autre provider
    // retombe sur le même user → autorisé sans effet de bord.
    const existing = { id: 'u-dual', email: 'pro@veridian.site', mfaEnabled: false };
    const { cb } = makeCallback([existing]);

    expect(await cb({ user: { email: 'pro@veridian.site' } })).toBe(true);
    expect(await cb({ user: { email: 'pro@veridian.site' } })).toBe(true);
  });
});

describe('Scénario I — email primaire Google ≠ Microsoft (2 users distincts)', () => {
  it('login Microsoft avec un email primaire différent → user inconnu en DB → autorise la création d\'un 2e user', async () => {
    // L'humain existe en DB via son compte Google `john.smith@gmail.com`.
    // Il se connecte via Microsoft, dont l'email primaire est `john@outlook.com`.
    // Auth.js v5 ne fait AUCUN merge heuristique : 2 emails = 2 users.
    const googleUser = { id: 'u-john-google', email: 'john.smith@gmail.com', mfaEnabled: false };
    const { cb, findUnique } = makeCallback([googleUser]);

    // Le provider Microsoft présente l'autre email.
    const result = await cb({ user: { email: 'john@outlook.com' } });

    // findUnique(john@outlook.com) → null → le callback autorise : le
    // PrismaAdapter va créer un 2e user distinct. Comportement ACCEPTÉ et
    // documenté (pas de flow "Merge accounts" — décision du ticket
    // oauth-scenarios-coverage).
    expect(result).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: 'john@outlook.com' },
      select: { id: true, email: true, mfaEnabled: true },
    });
  });

  it('les 2 identités restent indépendantes : login via l\'email Google retombe sur le user Google', async () => {
    // Après le scénario I, la DB contient 2 users. On vérifie qu'aucun des
    // deux logins ne « fuit » sur l'autre identité.
    const googleUser = { id: 'u-john-google', email: 'john.smith@gmail.com', mfaEnabled: false };
    const outlookUser = { id: 'u-john-outlook', email: 'john@outlook.com', mfaEnabled: false };
    const { cb } = makeCallback([googleUser, outlookUser]);

    // Chaque email résout son propre user, indépendamment.
    expect(await cb({ user: { email: 'john.smith@gmail.com' } })).toBe(true);
    expect(await cb({ user: { email: 'john@outlook.com' } })).toBe(true);
  });

  it('MFA est indépendante par identité : un user I avec MFA ne déclenche PAS la MFA de l\'autre', async () => {
    // Le user Outlook a la MFA, le user Google non. Chaque login applique
    // la politique MFA de SON user — pas de contamination croisée.
    const googleUser = { id: 'u-john-google', email: 'john.smith@gmail.com', mfaEnabled: false };
    const outlookUser = { id: 'u-john-outlook', email: 'john@outlook.com', mfaEnabled: true };
    const { cb } = makeCallback([googleUser, outlookUser]);

    expect(await cb({ user: { email: 'john.smith@gmail.com' } })).toBe(true);
    expect(await cb({ user: { email: 'john@outlook.com' } })).toBe(
      '/auth/mfa?uid=u-john-outlook',
    );
  });
});
