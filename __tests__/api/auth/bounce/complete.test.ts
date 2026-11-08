/**
 * Tests pour GET /api/auth/bounce/complete — Couche 4 Hub étape finale
 * (cf. CONTRAT-HUB §6bis.8.2 points 4-5).
 *
 * Couvre :
 *  - cookie absent → /dashboard, cookies vidés
 *  - cookie expiré / signature invalide → /dashboard, cookies vidés
 *  - cookie OK + pas de session Hub → /login?next=... (re-trigger possible)
 *  - cookie OK + session OK + downstream 200 → 302 magic_link_url, cookies vidés
 *  - cookie OK + session OK + downstream 400 user_not_in_app / hub_user_conflict → /auth/bounce/error qui l'explique,
 *    et une ligne `[bounce][refus]` (app, code, hub_user_id), jamais l'adresse
 *  - cookie OK + session OK + downstream 5xx → /auth/bounce/error?app=...&code=unreachable
 *  - cookie OK + session OK + ENV non configurée → /auth/bounce/error?code=not_configured
 *  - AUTH_SECRET manquant → /dashboard, cookies vidés
 *  - idempotence : refresh post-bounce ne re-bounce pas (cookie vidé)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const userFindUniqueMock = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: userFindUniqueMock } } }));
const ensureCrmMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/crm/provision', () => ({ ensureCrmWorkspace: (...a: unknown[]) => ensureCrmMock(...a) }));
const mockDenyUnlessEmailProven = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('@/lib/auth/email-proof', () => ({
  denyUnlessEmailProven: mockDenyUnlessEmailProven,
  isEmailProvenForSession: vi.fn(async () => true),
  issueEmailProof: vi.fn(async () => true),
}));
import { NextRequest } from 'next/server';
import { signNextCookie, NEXT_COOKIE_NAME_SECURE } from '@/lib/auth/bounce-next';

const TEST_SECRET = 'test-auth-secret-at-least-32-bytes-long-xx';

const getCurrentUserMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('@/lib/auth/get-user', () => ({
  getCurrentUser: () => getCurrentUserMock(),
  userUuid: (u: { supabaseUserId: string | null }) => {
    if (!u.supabaseUserId) throw new Error('no supabaseUserId');
    return u.supabaseUserId;
  },
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
  process.env.CRM_API_URL = 'https://crm.app.veridian.site';
  process.env.CRM_HUB_API_SECRET = 'crm-secret-test';
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

  it.each(['user_not_in_app', 'hub_user_conflict'])(
    'downstream 400 %s → /auth/bounce/error qui l\'explique, jamais un retour muet au tableau de bord',
    async (code) => {
      getCurrentUserMock.mockResolvedValue({
        id: 'user-1',
        email: 'a@b.c',
        name: null,
        image: null,
        supabaseUserId: 'uuid-1',
      });
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: code }), { status: 400 }));
      const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
      const { GET } = await import('@/app/api/auth/bounce/complete/route');
      const res = await GET(makeReq({ cookie }));
      const loc = new URL(res.headers.get('location')!);
      expect(loc.pathname).toBe('/auth/bounce/error');
      expect(loc.searchParams.get('app')).toBe('notifuse');
      expect(loc.searchParams.get('code')).toBe(code);
      expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBe('');
    },
  );

  it.each([
    ['user_not_in_app', 400, JSON.stringify({ error: 'user_not_in_app' })],
    ['hub_user_conflict', 400, JSON.stringify({ error: 'hub_user_conflict' })],
    ['unreachable', 500, 'boom'],
  ])('refus %s : une ligne [bounce][refus] avec app, code et hub_user_id, sans l\'adresse', async (code, status, corps) => {
    getCurrentUserMock.mockResolvedValue({
      id: 'user-1', email: 'secret@client.fr', name: null, image: null, supabaseUserId: 'uuid-1',
    });
    fetchMock.mockResolvedValue(new Response(corps, { status }));
    const lignes: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((l) => void lignes.push(String(l)));
    const error = vi.spyOn(console, 'error').mockImplementation((l) => void lignes.push(String(l)));
    try {
      const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
      const { GET } = await import('@/app/api/auth/bounce/complete/route');
      await GET(makeReq({ cookie }));
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
    const refus = lignes.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((j) => j?.tag === '[bounce][refus]');
    expect(refus).toHaveLength(1);
    expect(refus[0]).toMatchObject({ app: 'notifuse', code, hub_user_id: 'uuid-1', http_status: status });
    expect(lignes.join('\n')).not.toContain('secret@client.fr');
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

  it('adresse non prouvée → aucun appel à l\'app, retour au tableau de bord, cookies vidés', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u1', email: 'a@b.c', name: null, image: null, supabaseUserId: 'uuid-1',
    });
    mockDenyUnlessEmailProven.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(makeReq({ cookie }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toMatch(/\/dashboard$/);
  });

  it.each([
    ['requête RSC', { rsc: '1' }, ''],
    ['paramètre _rsc', {}, '?_rsc=abc'],
    ['préchargement Next', { 'next-router-prefetch': '1' }, ''],
    ['préchargement navigateur', { 'sec-purpose': 'prefetch' }, ''],
    ['fetch', { 'sec-fetch-mode': 'cors' }, ''],
  ])('%s : aucun lien émis, cookie intact, 204', async (_label, headers, query) => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u1', email: 'a@b.c', name: null, image: null, supabaseUserId: 'uuid-1',
    });
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const req = new NextRequest(`https://app.veridian.site/api/auth/bounce/complete${query}`);
    req.cookies.set(NEXT_COOKIE_NAME_SECURE, cookie);
    // Les en-têtes `sec-*` sont interdits au constructeur : le test les présente directement.
    const sent = headers as Record<string, string>;
    vi.spyOn(req.headers, 'get').mockImplementation((name: string) => sent[name.toLowerCase()] ?? null);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(req);
    expect(res.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDenyUnlessEmailProven).not.toHaveBeenCalled();
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)).toBeUndefined();
  });

  it.each([
    [new Date(), true],
    [null, undefined],
  ])('emailVerified=%s en base → email_proven=%s dans le corps signé', async (emailVerified, expected) => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u1', email: 'a@b.c', name: null, image: null, supabaseUserId: 'uuid-1',
    });
    userFindUniqueMock.mockResolvedValueOnce({ emailVerified });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ magic_link_url: 'https://notifuse.veridian.site/x' }), { status: 200 }),
    );
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    await GET(makeReq({ cookie: signNextCookie('https://notifuse.veridian.site/', TEST_SECRET) }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.email_proven).toBe(expected);
  });

  it('navigation réelle (sec-fetch-mode navigate) : le lien est émis', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u1', email: 'a@b.c', name: null, image: null, supabaseUserId: 'uuid-1',
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ magic_link_url: 'https://notifuse.veridian.site/x' }), { status: 200 }),
    );
    const req = new NextRequest('https://app.veridian.site/api/auth/bounce/complete');
    req.cookies.set(NEXT_COOKIE_NAME_SECURE, signNextCookie('https://notifuse.veridian.site/', TEST_SECRET));
    vi.spyOn(req.headers, 'get').mockImplementation((name: string) =>
      name.toLowerCase() === 'sec-fetch-mode' ? 'navigate' : null,
    );
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    const res = await GET(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.headers.get('location')).toBe('https://notifuse.veridian.site/x');
  });

  it('user sans supabaseUserId → aucun appel à l\'app : users.id ne sert jamais de hub_user_id', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'fallback-id', email: 'a@b.c', name: null, image: null, supabaseUserId: null,
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ magic_link_url: 'https://notifuse.veridian.site/auth/token?t=z' }), { status: 200 }),
    );
    const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
    const { GET } = await import('@/app/api/auth/bounce/complete/route');
    await GET(makeReq({ cookie }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('CRM : la première ouverture crée l\'espace', () => {
    const user = { id: 'user-1', email: 'a@b.c', name: 'Alice', image: null, supabaseUserId: 'uuid-1' };
    const refus = () => new Response(JSON.stringify({ error: 'user_not_in_app' }), { status: 400 });
    const lien = () => new Response(JSON.stringify({ magic_link_url: 'https://crm.app.veridian.site/auth/token?t=Z' }), { status: 200 });

    it('user_not_in_app → espace garanti, puis lien émis', async () => {
      getCurrentUserMock.mockResolvedValue(user);
      fetchMock.mockResolvedValueOnce(refus()).mockResolvedValueOnce(lien());
      ensureCrmMock.mockResolvedValue({ ok: true, workspaceId: 'ws-1', created: true });
      const cookie = signNextCookie('https://crm.app.veridian.site/', TEST_SECRET);
      const { GET } = await import('@/app/api/auth/bounce/complete/route');
      const res = await GET(makeReq({ cookie }));
      expect(res.headers.get('location')).toBe('https://crm.app.veridian.site/auth/token?t=Z');
      expect(ensureCrmMock).toHaveBeenCalledWith(expect.anything(), { hubUserId: 'uuid-1', email: 'a@b.c', name: 'Alice' }, expect.anything());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('création impossible → page d\'erreur, une seule nouvelle tentative au plus', async () => {
      getCurrentUserMock.mockResolvedValue(user);
      fetchMock.mockResolvedValue(refus());
      ensureCrmMock.mockResolvedValue({ ok: false, error: 'crm_http_502', status: 502 });
      const cookie = signNextCookie('https://crm.app.veridian.site/', TEST_SECRET);
      const { GET } = await import('@/app/api/auth/bounce/complete/route');
      const res = await GET(makeReq({ cookie }));
      const loc = new URL(res.headers.get('location')!);
      expect(loc.pathname).toBe('/auth/bounce/error');
      expect(loc.searchParams.get('code')).toBe('user_not_in_app');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('une autre app refusée ne crée jamais d\'espace CRM', async () => {
      getCurrentUserMock.mockResolvedValue(user);
      fetchMock.mockResolvedValue(refus());
      const cookie = signNextCookie('https://notifuse.veridian.site/', TEST_SECRET);
      const { GET } = await import('@/app/api/auth/bounce/complete/route');
      await GET(makeReq({ cookie }));
      expect(ensureCrmMock).not.toHaveBeenCalled();
    });
  });
});
