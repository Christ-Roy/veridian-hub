/**
 * Tests pour lib/auth/impersonation.ts — le cœur sécu de l'impersonation.
 *
 * Couvre (Mode Nuclear — tier 🔴 HAUT AUTH) :
 *  - hash SHA-256 stable + jamais le token brut en base
 *  - création de token : identifier préfixé, expiry 10min, stocké hashé
 *  - consommation : usage unique (delete atomique), token expiré, inconnu
 *  - JWT impersonation décodable par @auth/core avec le bon salt + claims
 *  - secureCookiesEnabled / sessionCookieName cohérents avec le scheme d'URL
 *  - isImpersonatedSession détecte les sessions impersonées
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decode } from 'next-auth/jwt';

import {
  IMPERSONATION_IDENTIFIER_PREFIX,
  IMPERSONATION_TOKEN_TTL_MS,
  IMPERSONATION_SESSION_TTL_S,
  hashImpersonationToken,
  tokenHashesEqual,
  createImpersonationToken,
  consumeImpersonationToken,
  encodeImpersonationSessionJwt,
  secureCookiesEnabled,
  sessionCookieName,
  isImpersonatedSession,
} from '@/lib/auth/impersonation';

const TEST_SECRET = 'test-auth-secret-at-least-32-bytes-long-xx';

describe('hashImpersonationToken', () => {
  it('produit un SHA-256 hex stable de 64 chars', () => {
    const h1 = hashImpersonationToken('abc');
    const h2 = hashImpersonationToken('abc');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('change de hash pour un token différent', () => {
    expect(hashImpersonationToken('abc')).not.toBe(hashImpersonationToken('abd'));
  });
});

describe('tokenHashesEqual', () => {
  it('true pour deux hash identiques', () => {
    const h = hashImpersonationToken('x');
    expect(tokenHashesEqual(h, h)).toBe(true);
  });
  it('false pour deux hash différents', () => {
    expect(tokenHashesEqual(hashImpersonationToken('x'), hashImpersonationToken('y'))).toBe(false);
  });
  it('false pour des longueurs différentes (pas de throw)', () => {
    expect(tokenHashesEqual('abc', 'abcdef')).toBe(false);
  });
});

describe('createImpersonationToken', () => {
  it('stocke un token HASHÉ (jamais le brut) avec identifier préfixé + TTL 10min', async () => {
    const create = vi.fn(async () => ({}));
    const prisma = { verificationToken: { create } } as never;
    const before = Date.now();

    const { rawToken, expires } = await createImpersonationToken(prisma, 'user-cuid-1');

    expect(rawToken).toMatch(/^[a-f0-9]{64}$/); // 32 bytes hex
    const callArg = create.mock.calls[0][0] as { data: Record<string, unknown> };
    // Le token stocké est le HASH du brut, pas le brut.
    expect(callArg.data.token).toBe(hashImpersonationToken(rawToken));
    expect(callArg.data.token).not.toBe(rawToken);
    // Identifier préfixé impersonate:<userId>
    expect(callArg.data.identifier).toBe(`${IMPERSONATION_IDENTIFIER_PREFIX}user-cuid-1`);
    // Expiry ~10min
    const expMs = (callArg.data.expires as Date).getTime();
    expect(expMs).toBeGreaterThanOrEqual(before + IMPERSONATION_TOKEN_TTL_MS - 1000);
    expect(expMs).toBeLessThanOrEqual(Date.now() + IMPERSONATION_TOKEN_TTL_MS + 1000);
    expect(expires).toBeInstanceOf(Date);
  });
});

describe('consumeImpersonationToken', () => {
  it('consomme un token valide et retourne le targetUserId (delete atomique)', async () => {
    const raw = 'a'.repeat(64);
    const hash = hashImpersonationToken(raw);
    const findUnique = vi.fn(async () => ({
      identifier: `${IMPERSONATION_IDENTIFIER_PREFIX}user-9`,
      token: hash,
      expires: new Date(Date.now() + 60_000),
    }));
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const prisma = { verificationToken: { findUnique, deleteMany } } as never;

    const res = await consumeImpersonationToken(prisma, raw);
    expect(res).toEqual({ ok: true, targetUserId: 'user-9' });
    // delete sur le HASH, pas le brut.
    expect(deleteMany).toHaveBeenCalledWith({ where: { token: hash } });
  });

  it('rejette un token inconnu (not_found)', async () => {
    const prisma = {
      verificationToken: { findUnique: vi.fn(async () => null), deleteMany: vi.fn() },
    } as never;
    const res = await consumeImpersonationToken(prisma, 'b'.repeat(64));
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejette un identifier non-impersonate (ne consomme pas un magic link)', async () => {
    const raw = 'c'.repeat(64);
    const prisma = {
      verificationToken: {
        findUnique: vi.fn(async () => ({
          identifier: 'magic-link:foo@bar.io', // pas un token impersonate
          token: hashImpersonationToken(raw),
          expires: new Date(Date.now() + 60_000),
        })),
        deleteMany: vi.fn(),
      },
    } as never;
    const res = await consumeImpersonationToken(prisma, raw);
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejette un token déjà consommé en parallèle (deleteMany count 0)', async () => {
    const raw = 'd'.repeat(64);
    const prisma = {
      verificationToken: {
        findUnique: vi.fn(async () => ({
          identifier: `${IMPERSONATION_IDENTIFIER_PREFIX}user-x`,
          token: hashImpersonationToken(raw),
          expires: new Date(Date.now() + 60_000),
        })),
        deleteMany: vi.fn(async () => ({ count: 0 })), // course perdue
      },
    } as never;
    const res = await consumeImpersonationToken(prisma, raw);
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejette un token expiré (expired) tout en le supprimant', async () => {
    const raw = 'e'.repeat(64);
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      verificationToken: {
        findUnique: vi.fn(async () => ({
          identifier: `${IMPERSONATION_IDENTIFIER_PREFIX}user-old`,
          token: hashImpersonationToken(raw),
          expires: new Date(Date.now() - 1000), // périmé
        })),
        deleteMany,
      },
    } as never;
    const res = await consumeImpersonationToken(prisma, raw);
    expect(res).toEqual({ ok: false, reason: 'expired' });
    // Même expiré, le token est supprimé → plus rejouable.
    expect(deleteMany).toHaveBeenCalled();
  });
});

describe('encodeImpersonationSessionJwt', () => {
  it('produit un JWT décodable par @auth/core avec le bon salt et les claims impersonation', async () => {
    const cookieName = sessionCookieName(true); // __Secure-...
    const jwt = await encodeImpersonationSessionJwt({
      user: { id: 'u-42', email: 'target@veridian.site', name: 'Target' },
      impersonatedBy: 'robert@veridian.site',
      secret: TEST_SECRET,
      secure: true,
    });
    expect(typeof jwt).toBe('string');

    // Décodable uniquement avec le bon salt (= nom du cookie).
    const decoded = await decode({ token: jwt, secret: TEST_SECRET, salt: cookieName });
    expect(decoded).not.toBeNull();
    expect(decoded?.uid).toBe('u-42');
    expect(decoded?.sub).toBe('u-42');
    expect(decoded?.email).toBe('target@veridian.site');
    expect(decoded?.impersonated).toBe(true);
    expect(decoded?.impersonatedBy).toBe('robert@veridian.site');
  });

  it('le JWT a un exp court (~1h, pas 90j)', async () => {
    const jwt = await encodeImpersonationSessionJwt({
      user: { id: 'u-1', email: 'a@b.io' },
      impersonatedBy: 'admin',
      secret: TEST_SECRET,
      secure: false,
    });
    const decoded = await decode({
      token: jwt,
      secret: TEST_SECRET,
      salt: sessionCookieName(false),
    });
    const now = Math.floor(Date.now() / 1000);
    expect(decoded?.exp).toBeGreaterThan(now);
    // Marge : exp <= now + 1h + 60s de tolérance, et bien < 1 jour.
    expect(decoded?.exp as number).toBeLessThanOrEqual(now + IMPERSONATION_SESSION_TTL_S + 60);
    expect(decoded?.exp as number).toBeLessThan(now + 24 * 60 * 60);
  });

  it('NE se décode PAS avec un mauvais salt (anti-fuite cross-cookie)', async () => {
    const jwt = await encodeImpersonationSessionJwt({
      user: { id: 'u-1', email: 'a@b.io' },
      impersonatedBy: 'admin',
      secret: TEST_SECRET,
      secure: true,
    });
    // @auth/core dérive la clé de chiffrement depuis (secret + salt). Avec un
    // mauvais salt, la décryption échoue dur (throw "no matching decryption
    // secret") — garantie plus forte qu'un simple null : le JWT est inutilisable.
    await expect(
      decode({ token: jwt, secret: TEST_SECRET, salt: 'wrong-salt' })
    ).rejects.toThrow();
  });

  it('throw si AUTH_SECRET absent — aucun JWT émis sans secret', async () => {
    const prev = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    await expect(
      encodeImpersonationSessionJwt({
        user: { id: 'u-1', email: 'a@b.io' },
        impersonatedBy: 'admin',
      })
    ).rejects.toThrow(/AUTH_SECRET/);
    if (prev !== undefined) process.env.AUTH_SECRET = prev;
  });
});

describe('secureCookiesEnabled / sessionCookieName', () => {
  let prev: { nextauth?: string; site?: string };
  beforeEach(() => {
    prev = {
      nextauth: process.env.NEXTAUTH_URL,
      site: process.env.NEXT_PUBLIC_SITE_URL,
    };
  });
  afterEach(() => {
    if (prev.nextauth === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = prev.nextauth;
    if (prev.site === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = prev.site;
  });

  it('HTTPS → secure cookies + préfixe __Secure-', () => {
    process.env.NEXTAUTH_URL = 'https://app.veridian.site';
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(secureCookiesEnabled()).toBe(true);
    expect(sessionCookieName()).toBe('__Secure-authjs.session-token');
  });

  it('http://localhost → non-secure + cookie non préfixé', () => {
    process.env.NEXTAUTH_URL = 'http://localhost:3000';
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(secureCookiesEnabled()).toBe(false);
    expect(sessionCookieName()).toBe('authjs.session-token');
  });

  it('aucune URL configurée → suppose dev local (non-secure)', () => {
    delete process.env.NEXTAUTH_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(secureCookiesEnabled()).toBe(false);
  });

  it('NEXTAUTH_URL a la précédence sur NEXT_PUBLIC_SITE_URL', () => {
    // La fonction lit `NEXTAUTH_URL || NEXT_PUBLIC_SITE_URL` : si NEXTAUTH_URL
    // est en HTTP, le scheme HTTPS de NEXT_PUBLIC_SITE_URL ne doit PAS le
    // surclasser. Garde-fou contre un cookie __Secure- posé en dev local
    // (qui serait alors rejeté par le navigateur sur http://).
    process.env.NEXTAUTH_URL = 'http://localhost:3000';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
    expect(secureCookiesEnabled()).toBe(false);
    expect(sessionCookieName()).toBe('authjs.session-token');

    // Et inversement : NEXTAUTH_URL HTTPS prime même si NEXT_PUBLIC_SITE_URL absent.
    process.env.NEXTAUTH_URL = 'https://app.veridian.site';
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(secureCookiesEnabled()).toBe(true);
  });

  it('fallback sur NEXT_PUBLIC_SITE_URL quand NEXTAUTH_URL est absent', () => {
    // Cas prod réel : seul NEXT_PUBLIC_SITE_URL est défini.
    delete process.env.NEXTAUTH_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
    expect(secureCookiesEnabled()).toBe(true);
    expect(sessionCookieName()).toBe('__Secure-authjs.session-token');
  });
});

describe('isImpersonatedSession', () => {
  it('true si session.user.impersonated', () => {
    expect(isImpersonatedSession({ user: { impersonated: true } })).toBe(true);
  });
  it('true si payload JWT brut impersonated', () => {
    expect(isImpersonatedSession({ impersonated: true })).toBe(true);
  });
  it('false pour une session normale', () => {
    expect(isImpersonatedSession({ user: { impersonated: false } })).toBe(false);
    expect(isImpersonatedSession({ user: {} })).toBe(false);
    expect(isImpersonatedSession(null)).toBe(false);
    expect(isImpersonatedSession(undefined)).toBe(false);
  });
});
