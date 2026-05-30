/**
 * Tests pour GET /api/auth/bounce/complete — Couche 4 Hub étape finale
 * (cf. CONTRAT-HUB §6bis.8.2 points 4-5).
 *
 * Couvre :
 *  - cookie absent → /dashboard, cookies vidés
 *  - cookie expiré / signature invalide → /dashboard, cookies vidés
 *  - cookie OK + pas de session Hub → /login?next=... (re-trigger possible)
 *  - cookie OK + session OK + downstream 200 → 302 magic_link_url, cookies vidés
 *  - cookie OK + session OK + downstream 400 user_not_in_app → /dashboard?app=...&hint=signup
 *  - cookie OK + session OK + downstream 5xx → /auth/bounce/error?app=...&code=unreachable
 *  - cookie OK + session OK + ENV non configurée → /auth/bounce/error?code=not_configured
 *  - AUTH_SECRET manquant → /dashboard, cookies vidés
 *  - idempotence : refresh post-bounce ne re-bounce pas (cookie vidé)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signNextCookie, NEXT_COOKIE_NAME_SECURE } from '@/lib/auth/bounce-next';

const TEST_SECRET = 'test-auth-secret-at-least-32-bytes-long-xx';

const getCurrentUserMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('@/lib/auth/get-user', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));

// Mock global fetch — utilisé par issueMagicLinkForApp.
beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = TEST_SECRET;
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
  process.env.NEXTAUTH_URL = 'https://app.veridian.site';
  process.env.DEPLOY_ENV = 'production';
  process.env.NOTIFUSE_API_URL = 'https://notifuse.veridian.site';
  process.env.NOTIFUSE_HUB_API_SECRET = 'hub-secret-test';
  // @ts-expect-error — patch global fetch pour les tests
  globalThis.fetch = fetchMock;
});

function makeReq(opts: { cookie?: string } = {}): NextRequest {
  const url = new URL('https://app.veridian.site/api/auth/bounce/complete');
  const req = new NextRequest(url);
  if (opts.cookie) {
    req.cookies.set(NEXT_COOKIE_NAME_SECURE, opts.cookie);
  }
  return req;
}

/** Derrière Traefik : req.url = host interne 0.0.0.0:3000. */
function makeReqBehindProxy(opts: { cookie?: string } = {}): NextRequest {
  const url = new URL('https://0.0.0.0:3000/api/auth/bounce/complete');
  const req = new NextRequest(url);
  if (opts.cookie) {
    req.cookies.set(NEXT_COOKIE_NAME_SECURE, opts.cookie);
  }
  return req;
}

describe('GET /api/auth/bounce/complete', () => {
  it('AUTH_SECRET manquant → redirect /dashboard, cookies vidés', async () => {
    delete process.env.AUTH_SECRET;
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq());
    expect(res.headers.get('location')).toContain('/dashboard');
    // Le cookies.delete pose un Set-Cookie maxAge=0
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBe('');
  });

  it('cookie absent → redirect /dashboard', async () => {
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq());
    expect(res.headers.get('location')).toContain('/dashboard');
    expect(res.headers.get('location')).not.toContain('app=');
    expect(getCurrentUserMock).not.toHaveBeenCalled();
  });

  it('derrière Traefik (req.url=0.0.0.0:3000) → redirect sur app.veridian.site, JAMAIS 0.0.0.0', async () => {
    // Régression du bug 2026-05-30 : les 7 new URL(path, req.url) héritaient
    // du host interne 0.0.0.0:3000. getHubBaseUrl force NEXT_PUBLIC_SITE_URL.
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReqBehindProxy());
    const loc = res.headers.get('location') ?? '';
    expect(loc).not.toContain('0.0.0.0');
    expect(loc.startsWith('https://app.veridian.site/dashboard')).toBe(true);
  });

  it('cookie expiré → redirect /dashboard, cookies vidés', async () => {
    // Crée un cookie déjà expiré (now - TTL - 1ms)
    const expiredCookie = signNextCookie(
      'https://notifuse.veridian.site/',
      TEST_SECRET,
      Date.now() - 11 * 60 * 1000,
    );
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie: expiredCookie }));
    expect(res.headers.get('location')).toContain('/dashboard');
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBe('');
  });

  it('cookie signature invalide → redirect /dashboard', async () => {
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie: 'fake.cookie.value' }));
    expect(res.headers.get('location')).toContain('/dashboard');
  });

  it('cookie OK + pas de session → redirect /login?next=...', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const cookie = signNextCookie('https://notifuse.veridian.site/signin', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie }));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/login');
    expect(loc).toContain('next=');
    expect(loc).toContain(encodeURIComponent('notifuse.veridian.site'));
  });

  it('cookie OK + session OK + downstream 200 → 302 magic_link_url, cookies vidés', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.c',
      name: null,
      image: null,
      supabaseUserId: 'uuid-bridge-1',
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ magic_link_url: 'https://notifuse.app.veridian.site/auth/token?t=ZZZ' }),
        { status: 200 },
      ),
    );
    const cookie = signNextCookie('https://notifuse.veridian.site/leads', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie }));
    expect(res.headers.get('location')).toBe(
      'https://notifuse.app.veridian.site/auth/token?t=ZZZ',
    );
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBe('');

    // Le payload envoyé contient le bon hub_user_id (supabaseUserId bridge)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.hub_user_id).toBe('uuid-bridge-1');
    expect(body.email).toBe('a@b.c');
  });

  it('downstream 400 user_not_in_app → /dashboard?app=notifuse&hint=signup', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.c',
      name: null,
      image: null,
      supabaseUserId: 'uuid-1',
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'user_not_in_app' }), { status: 400 }),
    );
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie }));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/dashboard');
    expect(loc).toContain('app=notifuse');
    expect(loc).toContain('hint=signup');
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBe('');
  });

  it('downstream 500 → /auth/bounce/error?app=notifuse&code=unreachable', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.c',
      name: null,
      image: null,
      supabaseUserId: 'uuid-1',
    });
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie }));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/auth/bounce/error');
    expect(loc).toContain('app=notifuse');
    expect(loc).toContain('code=unreachable');
  });

  it('downstream 404 (endpoint pas implémenté) → /auth/bounce/error code=unreachable', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u', email: 'a@b.c', name: null, image: null, supabaseUserId: 'u',
    });
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie }));
    expect(res.headers.get('location')).toContain('code=unreachable');
  });

  it('ENV app non configurée → /auth/bounce/error code=not_configured', async () => {
    delete process.env.NOTIFUSE_API_URL;
    delete process.env.NOTIFUSE_HUB_API_SECRET;
    getCurrentUserMock.mockResolvedValue({
      id: 'u', email: 'a@b.c', name: null, image: null, supabaseUserId: 'u',
    });
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie }));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/auth/bounce/error');
    expect(loc).toContain('code=not_configured');
    // pas d'appel fetch tenté
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('idempotence : succès → cookies vidés (refresh ne re-bounce pas)', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u', email: 'a@b.c', name: null, image: null, supabaseUserId: 'u',
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ magic_link_url: 'https://notifuse.veridian.site/auth/token?t=x' }), { status: 200 }),
    );
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie }));
    // cookies de bounce supprimés sur la réponse (value vidée par delete())
    const setSecure = res.cookies.get(NEXT_COOKIE_NAME_SECURE);
    expect(setSecure?.value).toBe('');
  });

  it('downstream user_not_in_app : cookies vidés', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u', email: 'a@b.c', name: null, image: null, supabaseUserId: 'u',
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'user_not_in_app' }), { status: 400 }),
    );
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie }));
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBe('');
  });

  it('downstream 5xx : cookies vidés (anti-replay même sur erreur)', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u', email: 'a@b.c', name: null, image: null, supabaseUserId: 'u',
    });
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie }));
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBe('');
  });

  it('user sans email (cas pathologique) → re-login (pas de bounce malformé)', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u', email: null as never, name: null, image: null, supabaseUserId: 'u',
    });
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie }));
    expect(res.headers.get('location')).toContain('/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('user sans supabaseUserId → fallback sur user.id pour hub_user_id', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'fallback-id', email: 'a@b.c', name: null, image: null, supabaseUserId: null,
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ magic_link_url: 'https://notifuse.veridian.site/auth/token?t=z' }), { status: 200 }),
    );
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    await GET(makeReq({ cookie }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.hub_user_id).toBe('fallback-id');
  });
});
