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
  /** Ligne `account` déjà liée (provider, providerAccountId) : vaut pour un user existant. */
  linkedAccount?: { userId: string } | null;
} = {}) {
  const findUnique = vi.fn(async () => opts.user ?? null);
  const accountFindUnique = vi.fn(async () => opts.linkedAccount ?? null);
  const applyProviderEmailProof = vi.fn(async () => undefined);
  const issueAndSendMfaCode = vi.fn(async () => {
    if (opts.issueMfaThrows) throw new Error('SMTP down');
    return { ok: true };
  });
  const logger = { error: vi.fn() };
  return {
    prisma: { user: { findUnique }, account: { findUnique: accountFindUnique } } as never,
    issueAndSendMfaCode,
    applyProviderEmailProof,
    logger,
    _findUnique: findUnique,
    _accountFindUnique: accountFindUnique,
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

  it('Scénario C — user existant, Google avec email_verified=false, pas de ligne account : REFUSE (D1)', async () => {
    const deps = makeDeps({
      user: { id: 'u1', email: 'existing@gmail.com', mfaEnabled: false },
    });
    const cb = createSignInCallback(deps);
    const r = await cb({
      user: { email: 'existing@gmail.com' },
      account: { provider: 'google', providerAccountId: 'g-1' },
      profile: { email: 'existing@gmail.com', email_verified: false },
    });
    expect(r).toBe('/auth/liaison-refusee');
    expect(deps.applyProviderEmailProof).not.toHaveBeenCalled();
    expect(deps.issueAndSendMfaCode).not.toHaveBeenCalled();
  });

  it('Scénario D — user existant, Entra sans xms_edov (compte perso ou nOAuth), pas de ligne account : REFUSE (D1)', async () => {
    const deps = makeDeps({
      user: { id: 'u2', email: 'existing@outlook.com', mfaEnabled: false },
    });
    const cb = createSignInCallback(deps);
    const r = await cb({
      user: { email: 'existing@outlook.com' },
      account: { provider: 'microsoft-entra-id', providerAccountId: 'ms-1' },
      profile: { email: 'existing@outlook.com' },
    });
    expect(r).toBe('/auth/liaison-refusee');
    expect(deps.applyProviderEmailProof).not.toHaveBeenCalled();
  });

  it('D1 — Entra avec xms_edov : adresse prouvée, liaison autorisée et preuve appliquée avec le fournisseur', async () => {
    const deps = makeDeps({
      user: { id: 'u2', email: 'existing@corp.fr', mfaEnabled: false },
    });
    const cb = createSignInCallback(deps);
    const r = await cb({
      user: { email: 'existing@corp.fr' },
      account: { provider: 'microsoft-entra-id', providerAccountId: 'ms-2' },
      profile: { email: 'existing@corp.fr', xms_edov: true },
    });
    expect(r).toBe(true);
    expect(deps.applyProviderEmailProof).toHaveBeenCalledWith(expect.anything(), 'u2', 'microsoft-entra-id');
  });

  it('Scénario E — user déjà lié (ligne account), re-login sans preuve cette fois : autorise (D1)', async () => {
    const deps = makeDeps({
      user: { id: 'u1', email: 'already-linked@gmail.com', mfaEnabled: false },
      linkedAccount: { userId: 'u1' },
    });
    const cb = createSignInCallback(deps);
    const r = await cb({
      user: { email: 'already-linked@gmail.com' },
      account: { provider: 'google', providerAccountId: 'g-2' },
      profile: { email: 'already-linked@gmail.com', email_verified: false },
    });
    expect(r).toBe(true);
    expect(deps.applyProviderEmailProof).not.toHaveBeenCalled();
    expect(deps._accountFindUnique).toHaveBeenCalledWith({
      where: { provider_providerAccountId: { provider: 'google', providerAccountId: 'g-2' } },
      select: { userId: true },
    });
  });

  it('Scénario F — ligne account liée à un AUTRE user, même email : REFUSE (D1)', async () => {
    const deps = makeDeps({
      user: { id: 'u1', email: 'dual@gmail.com', mfaEnabled: false },
      linkedAccount: { userId: 'autre-user' },
    });
    const cb = createSignInCallback(deps);
    const r = await cb({
      user: { email: 'dual@gmail.com' },
      account: { provider: 'google', providerAccountId: 'g-3' },
      profile: { email: 'dual@gmail.com', email_verified: false },
    });
    expect(r).toBe('/auth/liaison-refusee');
  });

  it('credentials : pas de garde OAuth, le mot de passe passe par authorize', async () => {
    const deps = makeDeps({
      user: { id: 'u1', email: 'cred@x.fr', mfaEnabled: false },
    });
    const cb = createSignInCallback(deps);
    expect(await cb({ user: { email: 'cred@x.fr' }, account: { provider: 'credentials' } })).toBe(true);
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
