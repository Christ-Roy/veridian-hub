/**
 * Tests unitaires de `lib/auth/sign-in-callback.ts`.
 *
 * Couvre les scénarios OAuth A-F + MFA documentés dans
 * `todo/2026-05-20-oauth-scenarios-coverage.md`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSignInCallback } from '@/lib/auth/sign-in-callback';

function makeDeps(opts: {
  user?: { id: string; email: string; mfaEnabled: boolean } | null;
  issueMfaThrows?: boolean;
} = {}) {
  const findUnique = vi.fn(async () => opts.user ?? null);
  const issueAndSendMfaCode = vi.fn(async () => {
    if (opts.issueMfaThrows) throw new Error('SMTP down');
    return { ok: true };
  });
  const logger = { error: vi.fn() };
  return {
    prisma: { user: { findUnique } } as never,
    issueAndSendMfaCode,
    logger,
    _findUnique: findUnique,
  };
}

describe('createSignInCallback — scénarios OAuth', () => {
  it('refuse l\'auth si user.email est absent (durcissement défense en profondeur)', async () => {
    const deps = makeDeps();
    const cb = createSignInCallback(deps);
    expect(await cb({ user: { email: null } })).toBe(false);
    expect(await cb({ user: {} })).toBe(false);
    expect(deps._findUnique).not.toHaveBeenCalled();
  });

  it('Scénario A — nouvel user signup Google : DB findUnique renvoie null → autorise (PrismaAdapter créera user)', async () => {
    const deps = makeDeps({ user: null });
    const cb = createSignInCallback(deps);
    const r = await cb({ user: { email: 'new.user@gmail.com' } });
    expect(r).toBe(true);
    expect(deps._findUnique).toHaveBeenCalledWith({
      where: { email: 'new.user@gmail.com' },
      select: { id: true, email: true, mfaEnabled: true },
    });
    expect(deps.issueAndSendMfaCode).not.toHaveBeenCalled();
  });

  it('Scénario B — nouvel user signup Microsoft : même chemin que A', async () => {
    const deps = makeDeps({ user: null });
    const cb = createSignInCallback(deps);
    expect(await cb({ user: { email: 'new.user@outlook.com' } })).toBe(true);
  });

  it('Scénario C — user existant (Credentials) tente login Google sans MFA : autorise (link auto via flag provider)', async () => {
    const deps = makeDeps({
      user: { id: 'u1', email: 'existing@gmail.com', mfaEnabled: false },
    });
    const cb = createSignInCallback(deps);
    const r = await cb({ user: { email: 'existing@gmail.com' } });
    // Le link account_provider ↔ user existant est géré par le PrismaAdapter
    // grâce à `allowDangerousEmailAccountLinking: true` côté Google provider.
    // Le callback signIn n'a juste pas à bloquer.
    expect(r).toBe(true);
    expect(deps.issueAndSendMfaCode).not.toHaveBeenCalled();
  });

  it('Scénario D — user existant tente login Microsoft sans MFA : idem C', async () => {
    const deps = makeDeps({
      user: { id: 'u2', email: 'existing@outlook.com', mfaEnabled: false },
    });
    const cb = createSignInCallback(deps);
    expect(await cb({ user: { email: 'existing@outlook.com' } })).toBe(true);
  });

  it('Scénario E — user déjà linké Google → re-login Google : autorise (idempotent)', async () => {
    const deps = makeDeps({
      user: { id: 'u1', email: 'already-linked@gmail.com', mfaEnabled: false },
    });
    const cb = createSignInCallback(deps);
    expect(await cb({ user: { email: 'already-linked@gmail.com' } })).toBe(true);
  });

  it('Scénario F — user linké Google tente Microsoft (même email, MFA off) : autorise (PrismaAdapter ajoute row accounts)', async () => {
    const deps = makeDeps({
      user: { id: 'u1', email: 'dual@gmail.com', mfaEnabled: false },
    });
    const cb = createSignInCallback(deps);
    expect(await cb({ user: { email: 'dual@gmail.com' } })).toBe(true);
  });
});

describe('createSignInCallback — MFA flow', () => {
  it('user avec MFA=true : génère + envoie code, redirige vers /auth/mfa avec uid encodé', async () => {
    const deps = makeDeps({
      user: { id: 'user-with-mfa-123', email: 'mfa@example.com', mfaEnabled: true },
    });
    const cb = createSignInCallback(deps);
    const r = await cb({ user: { email: 'mfa@example.com' } });
    expect(r).toBe('/auth/mfa?uid=user-with-mfa-123');
    expect(deps.issueAndSendMfaCode).toHaveBeenCalledWith({
      id: 'user-with-mfa-123',
      email: 'mfa@example.com',
    });
  });

  it('user MFA avec id contenant des chars spéciaux : URI-encode correctement', async () => {
    const deps = makeDeps({
      user: { id: 'user/with+special&chars', email: 'a@b.c', mfaEnabled: true },
    });
    const cb = createSignInCallback(deps);
    const r = await cb({ user: { email: 'a@b.c' } });
    expect(r).toBe('/auth/mfa?uid=user%2Fwith%2Bspecial%26chars');
  });

  it('user MFA mais envoi mail échoue : retourne false (sécurité — pas de session sans MFA validée)', async () => {
    const deps = makeDeps({
      user: { id: 'u1', email: 'mfa@example.com', mfaEnabled: true },
      issueMfaThrows: true,
    });
    const cb = createSignInCallback(deps);
    expect(await cb({ user: { email: 'mfa@example.com' } })).toBe(false);
    expect(deps.logger.error).toHaveBeenCalledWith(
      '[auth] failed to issue MFA code',
      expect.any(Error),
    );
  });
});

describe('createSignInCallback — contrat Auth.js v5', () => {
  // Garde-fou : si Auth.js change le contrat signIn (genre passe à des
  // Promise<Response>), ces tests catch immédiatement.
  it('toujours renvoie boolean ou string (jamais undefined/null/object)', async () => {
    const cases = [
      { user: { email: null }, expectedType: 'boolean' },
      { user: { email: 'a@b.c' }, dbUser: null, expectedType: 'boolean' },
      { user: { email: 'a@b.c' }, dbUser: { id: 'u1', email: 'a@b.c', mfaEnabled: false }, expectedType: 'boolean' },
      { user: { email: 'a@b.c' }, dbUser: { id: 'u1', email: 'a@b.c', mfaEnabled: true }, expectedType: 'string' },
    ] as const;

    for (const c of cases) {
      const deps = makeDeps({ user: c.dbUser ?? null });
      const cb = createSignInCallback(deps);
      const r = await cb({ user: c.user });
      expect(typeof r, `case ${JSON.stringify(c.user)}`).toBe(c.expectedType);
    }
  });
});
