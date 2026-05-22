/**
 * Tests pour GET /api/auth/impersonate-callback.
 *
 * Couvre (Mode Nuclear — tier 🔴 HAUT AUTH) :
 *  - token manquant → redirect erreur
 *  - token invalide / inconnu → redirect erreur 410
 *  - token expiré → redirect erreur 410
 *  - token déjà consommé (deleteMany count 0) → redirect erreur
 *  - user cible supprimé entre-temps → redirect erreur 404
 *  - succès : cookie de session Auth.js posé + redirect /dashboard + audit log
 *  - le cookie est un JWT impersonation valide (impersonated=true)
 *  - contexte HTTP local → cookie non préfixé (secure=false)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decode } from 'next-auth/jwt';

const TEST_SECRET = 'test-auth-secret-at-least-32-bytes-long-xx';

const verificationTokenFindUnique = vi.fn();
const verificationTokenDeleteMany = vi.fn();
const userFindUnique = vi.fn();
const auditLogCreate = vi.fn(async () => ({}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    verificationToken: {
      findUnique: verificationTokenFindUnique,
      deleteMany: verificationTokenDeleteMany,
    },
    user: { findUnique: userFindUnique },
    auditLog: { create: auditLogCreate },
  },
}));

import { hashImpersonationToken, sessionCookieName } from '@/lib/auth/impersonation';

/** Construit une requête minimale avec un searchParam `token`. */
function makeReq(token?: string) {
  const url = new URL('https://app.veridian.site/api/auth/impersonate-callback');
  if (token !== undefined) url.searchParams.set('token', token);
  return { nextUrl: url } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = TEST_SECRET;
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
  process.env.NEXTAUTH_URL = 'https://app.veridian.site';
});

describe('GET /api/auth/impersonate-callback', () => {
  it('token manquant → redirect avec error', async () => {
    const { GET } = await import('@/app/api/auth/impersonate-callback/route');
    const res = await GET(makeReq());
    expect(res.headers.get('location')).toContain('/login?error=impersonate_missing_token');
    expect(verificationTokenFindUnique).not.toHaveBeenCalled();
  });

  it('token inconnu → redirect impersonate_token_invalid', async () => {
    verificationTokenFindUnique.mockResolvedValue(null);
    const { GET } = await import('@/app/api/auth/impersonate-callback/route');
    const res = await GET(makeReq('f'.repeat(64)));
    expect(res.headers.get('location')).toContain('error=impersonate_token_invalid');
  });

  it('token expiré → redirect impersonate_token_expired', async () => {
    const raw = 'a'.repeat(64);
    verificationTokenFindUnique.mockResolvedValue({
      identifier: 'impersonate:user-1',
      token: hashImpersonationToken(raw),
      expires: new Date(Date.now() - 1000),
    });
    verificationTokenDeleteMany.mockResolvedValue({ count: 1 });
    const { GET } = await import('@/app/api/auth/impersonate-callback/route');
    const res = await GET(makeReq(raw));
    expect(res.headers.get('location')).toContain('error=impersonate_token_expired');
  });

  it('token déjà consommé (course perdue) → redirect invalid', async () => {
    const raw = 'b'.repeat(64);
    verificationTokenFindUnique.mockResolvedValue({
      identifier: 'impersonate:user-1',
      token: hashImpersonationToken(raw),
      expires: new Date(Date.now() + 60_000),
    });
    verificationTokenDeleteMany.mockResolvedValue({ count: 0 });
    const { GET } = await import('@/app/api/auth/impersonate-callback/route');
    const res = await GET(makeReq(raw));
    expect(res.headers.get('location')).toContain('error=impersonate_token_invalid');
  });

  it('user cible supprimé entre-temps → redirect impersonate_user_gone', async () => {
    const raw = 'c'.repeat(64);
    verificationTokenFindUnique.mockResolvedValue({
      identifier: 'impersonate:user-gone',
      token: hashImpersonationToken(raw),
      expires: new Date(Date.now() + 60_000),
    });
    verificationTokenDeleteMany.mockResolvedValue({ count: 1 });
    userFindUnique.mockResolvedValue(null);
    const { GET } = await import('@/app/api/auth/impersonate-callback/route');
    const res = await GET(makeReq(raw));
    expect(res.headers.get('location')).toContain('error=impersonate_user_gone');
  });

  it('succès : pose le cookie de session + redirect /dashboard + audit log', async () => {
    const raw = 'd'.repeat(64);
    verificationTokenFindUnique.mockResolvedValue({
      identifier: 'impersonate:user-42',
      token: hashImpersonationToken(raw),
      expires: new Date(Date.now() + 60_000),
    });
    verificationTokenDeleteMany.mockResolvedValue({ count: 1 });
    userFindUnique.mockResolvedValue({
      id: 'user-42',
      email: 'target@veridian.site',
      name: 'Target User',
      image: null,
    });

    const { GET } = await import('@/app/api/auth/impersonate-callback/route');
    const res = await GET(makeReq(raw));

    // Redirige vers le dashboard.
    expect(res.headers.get('location')).toContain('/dashboard');

    // Cookie de session posé.
    const cookie = res.cookies.get(sessionCookieName(true));
    expect(cookie).toBeDefined();
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('lax');

    // Le cookie est un JWT impersonation valide.
    const decoded = await decode({
      token: cookie!.value,
      secret: TEST_SECRET,
      salt: sessionCookieName(true),
    });
    expect(decoded?.uid).toBe('user-42');
    expect(decoded?.impersonated).toBe(true);

    // Audit log consume.
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    const auditArg = auditLogCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('admin.impersonate.consume');
    expect(auditArg.data.targetId).toBe('user-42');
  });

  it('contexte HTTP local → cookie non préfixé (authjs.session-token, secure=false)', async () => {
    // En dev local (NEXTAUTH_URL en http://), secureCookiesEnabled() retourne
    // false → le callback doit poser le cookie SANS préfixe __Secure- et avec
    // secure=false. Sinon le navigateur rejette le cookie sur http:// et la
    // session impersonée ne s'établit jamais. Couvre le chemin du cookie name
    // dans le callback (le pendant du test "succès" qui, lui, est en HTTPS).
    process.env.NEXTAUTH_URL = 'http://localhost:3000';
    process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';
    const raw = 'f'.repeat(64);
    verificationTokenFindUnique.mockResolvedValue({
      identifier: 'impersonate:user-local',
      token: hashImpersonationToken(raw),
      expires: new Date(Date.now() + 60_000),
    });
    verificationTokenDeleteMany.mockResolvedValue({ count: 1 });
    userFindUnique.mockResolvedValue({
      id: 'user-local',
      email: 'dev@localhost',
      name: null,
      image: null,
    });

    const { GET } = await import('@/app/api/auth/impersonate-callback/route');
    const res = await GET(makeReq(raw));

    // Cookie posé sous le nom NON préfixé.
    const cookie = res.cookies.get(sessionCookieName(false));
    expect(cookie).toBeDefined();
    expect(cookie?.secure).toBe(false);
    // Le cookie __Secure- ne doit PAS exister en contexte HTTP.
    expect(res.cookies.get('__Secure-authjs.session-token')).toBeUndefined();

    // Le JWT reste décodable avec le salt = nom du cookie non préfixé.
    const decoded = await decode({
      token: cookie!.value,
      secret: TEST_SECRET,
      salt: sessionCookieName(false),
    });
    expect(decoded?.uid).toBe('user-local');
    expect(decoded?.impersonated).toBe(true);
  });

  it('AUTH_SECRET absent → aucun cookie posé, redirect erreur', async () => {
    delete process.env.AUTH_SECRET;
    const raw = 'e'.repeat(64);
    verificationTokenFindUnique.mockResolvedValue({
      identifier: 'impersonate:user-1',
      token: hashImpersonationToken(raw),
      expires: new Date(Date.now() + 60_000),
    });
    verificationTokenDeleteMany.mockResolvedValue({ count: 1 });
    userFindUnique.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.io',
      name: null,
      image: null,
    });

    const { GET } = await import('@/app/api/auth/impersonate-callback/route');
    const res = await GET(makeReq(raw));
    expect(res.headers.get('location')).toContain('error=impersonate_session_error');
    expect(res.cookies.get('__Secure-authjs.session-token')).toBeUndefined();
  });
});
