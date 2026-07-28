/**
 * Tests pour le wrapper rate-limit autour des handlers Auth.js.
 *
 * On ne teste PAS les handlers Auth.js eux-mêmes (c'est la lib upstream),
 * on teste que :
 *  - Le rate-limit est appliqué sur /api/auth/signin*
 *  - Le rate-limit est appliqué sur /api/auth/callback*
 *  - Les autres routes Auth.js (session, csrf, providers) PASSENT sans limit
 *  - Les requêtes au-delà du cap reçoivent 429 + Retry-After
 *  - L'IP est extraite de x-forwarded-for
 *
 * Stratégie : on mock '@/auth' pour intercepter handlers.GET/POST et
 * vérifier qu'ils sont appelés (ou pas) selon le pathname + cap.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const upstreamGetMock = vi.fn(async () => new Response('ok', { status: 200 }));
const upstreamPostMock = vi.fn(async () => new Response('ok', { status: 200 }));

vi.mock('@/auth', () => ({
  handlers: {
    GET: upstreamGetMock,
    POST: upstreamPostMock,
  },
}));

import {
  oauthStartLimiter,
  oauthCallbackLimiter,
  credentialsLoginLimiter,
} from '@/lib/auth/rate-limit';

beforeEach(() => {
  upstreamGetMock.mockClear();
  upstreamPostMock.mockClear();
  oauthStartLimiter.reset();
  oauthCallbackLimiter.reset();
  credentialsLoginLimiter.reset();
});

const buildReq = (
  path: string,
  ip = '1.2.3.4',
  method: 'GET' | 'POST' = 'GET',
  extraHeaders: Record<string, string> = {},
) =>
  new Request(`http://hub.test${path}`, {
    method,
    headers: { 'x-forwarded-for': ip, ...extraHeaders },
  });

describe('Rate-limit wrapper Auth.js — /api/auth/signin', () => {
  it('laisse passer ≤ 10 requêtes/min/IP, refuse la 11e avec 429', async () => {
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 10; i++) {
      const res = await GET(buildReq('/api/auth/signin'));
      expect(res.status).toBe(200);
    }
    const blocked = await GET(buildReq('/api/auth/signin'));
    expect(blocked.status).toBe(429);
    const retry = blocked.headers.get('Retry-After');
    expect(retry).toBeTruthy();
    expect(Number(retry)).toBeGreaterThan(0);
    expect(upstreamGetMock).toHaveBeenCalledTimes(10);
  });

  it('refuse aussi sur les sous-chemins /api/auth/signin/google', async () => {
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 10; i++) {
      await GET(buildReq('/api/auth/signin/google'));
    }
    const blocked = await GET(buildReq('/api/auth/signin/google'));
    expect(blocked.status).toBe(429);
  });

  it('compte indépendamment par IP', async () => {
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 10; i++) {
      await GET(buildReq('/api/auth/signin', '1.2.3.4'));
    }
    expect((await GET(buildReq('/api/auth/signin', '1.2.3.4'))).status).toBe(429);
    // Autre IP : pas bloquée
    expect((await GET(buildReq('/api/auth/signin', '5.6.7.8'))).status).toBe(200);
  });
});

describe('Rate-limit wrapper Auth.js — /api/auth/callback', () => {
  it('laisse passer ≤ 30/min/IP, refuse la 31e', async () => {
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 30; i++) {
      const res = await GET(buildReq('/api/auth/callback/google'));
      expect(res.status).toBe(200);
    }
    const blocked = await GET(buildReq('/api/auth/callback/google'));
    expect(blocked.status).toBe(429);
  });
});

describe('Rate-limit wrapper Auth.js — /api/auth/callback/credentials (anti-brute-force password)', () => {
  it('laisse passer ≤ 5/min/IP, refuse la 6e avec 429 (limit STRICT)', async () => {
    const { POST } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 5; i++) {
      const res = await POST(buildReq('/api/auth/callback/credentials', '7.7.7.7', 'POST'));
      expect(res.status).toBe(200);
    }
    const blocked = await POST(buildReq('/api/auth/callback/credentials', '7.7.7.7', 'POST'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    // Le limiter générique callback (30/min) n'a PAS été consommé,
    // c'est bien credentialsLoginLimiter (5/min) qui a tapé.
  });

  it('callback Google reste à 30/min (pas impacté par limiter credentials)', async () => {
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    // 10 tentatives credentials (saturent credentialsLoginLimiter à 5)
    for (let i = 0; i < 10; i++) {
      await GET(buildReq('/api/auth/callback/credentials', '8.8.8.8'));
    }
    // Google callback toujours OK depuis même IP (limiter séparé)
    const res = await GET(buildReq('/api/auth/callback/google', '8.8.8.8'));
    expect(res.status).toBe(200);
  });
});

describe('Rate-limit wrapper Auth.js — autres routes (pas de limit)', () => {
  it('ne limite pas /api/auth/session (appelé par page render)', async () => {
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 100; i++) {
      const res = await GET(buildReq('/api/auth/session'));
      expect(res.status).toBe(200);
    }
    expect(upstreamGetMock).toHaveBeenCalledTimes(100);
  });

  it('ne limite pas /api/auth/csrf', async () => {
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 50; i++) {
      await GET(buildReq('/api/auth/csrf'));
    }
    expect(upstreamGetMock).toHaveBeenCalledTimes(50);
  });

  it('ne limite pas /api/auth/providers', async () => {
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 50; i++) {
      await GET(buildReq('/api/auth/providers'));
    }
    expect(upstreamGetMock).toHaveBeenCalledTimes(50);
  });
});

describe('Rate-limit wrapper Auth.js — POST', () => {
  it('applique aussi le rate-limit sur POST /api/auth/signin', async () => {
    const { POST } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 10; i++) {
      const res = await POST(buildReq('/api/auth/signin', '9.9.9.9', 'POST'));
      expect(res.status).toBe(200);
    }
    const blocked = await POST(buildReq('/api/auth/signin', '9.9.9.9', 'POST'));
    expect(blocked.status).toBe(429);
  });
});

// ─── Suppression du cookie hint au signOut ───────────────────────────────
// Non-régression : le signOut Auth.js ne supprimait QUE son propre cookie
// session. Le hint cross-subdomain `veridian-session-hint` (TTL 30j) lui
// survivait → landing veridian.site connectée pendant un mois après la
// déconnexion. Le wrapper doit greffer le Set-Cookie de suppression sur la
// réponse Auth.js, sans jamais abîmer les cookies qu'elle pose déjà.
describe('Wrapper Auth.js — clear du cookie hint au signOut', () => {
  const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
  const ORIG_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.DEPLOY_ENV = 'prod';
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
    else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
    process.env.NODE_ENV = ORIG_NODE_ENV;
  });

  const hintCookieOf = (res: Response) =>
    res.headers.getSetCookie().find((c) => c.startsWith('veridian-session-hint='));

  it('POST /api/auth/signout → Set-Cookie hint Max-Age=0 sur le bon domaine', async () => {
    const { POST } = await import('@/app/api/auth/[...nextauth]/route');
    const res = await POST(buildReq('/api/auth/signout', '11.11.11.11', 'POST'));
    const hint = hintCookieOf(res);
    expect(hint).toBeTruthy();
    expect(hint).toContain('veridian-session-hint=;');
    expect(hint).toContain('Max-Age=0');
    expect(hint).toContain('Domain=.veridian.site');
  });

  it('réponse 302 : le Set-Cookie survit à la redirection et le status est intact', async () => {
    // Cas réel : signOut({callbackUrl}) → Auth.js répond 302 + Set-Cookie de
    // suppression de sa session. Un navigateur applique bien les Set-Cookie
    // d'une 302 — encore faut-il ne pas écraser ceux d'Auth.js.
    upstreamPostMock.mockImplementationOnce(async () => {
      const upstream = new Response(null, {
        status: 302,
        headers: { location: 'https://app.veridian.site/' },
      });
      // Set-Cookie posé APRÈS construction : happy-dom (env de test) perd les
      // set-cookie fournis à l'init de Response. Node/undici, lui, les garde.
      upstream.headers.append(
        'set-cookie',
        '__Secure-authjs.session-token=; Path=/; Max-Age=0',
      );
      return upstream;
    });
    const { POST } = await import('@/app/api/auth/[...nextauth]/route');
    const res = await POST(buildReq('/api/auth/signout', '11.11.11.12', 'POST'));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app.veridian.site/');
    const cookies = res.headers.getSetCookie();
    // Les DEUX cookies doivent être présents, chacun sur sa propre ligne.
    expect(cookies.some((c) => c.startsWith('__Secure-authjs.session-token='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('veridian-session-hint='))).toBe(true);
  });

  it('GET /api/auth/signout (page de confirmation) → PAS de clear', async () => {
    // Rien n'est encore déconnecté à ce stade : supprimer le hint ici
    // délogguerait la landing pour un simple affichage de page.
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    const res = await GET(buildReq('/api/auth/signout', '11.11.11.13'));
    expect(hintCookieOf(res)).toBeUndefined();
  });

  it('POST sur une autre route Auth.js (/session) → PAS de clear', async () => {
    const { POST } = await import('@/app/api/auth/[...nextauth]/route');
    const res = await POST(buildReq('/api/auth/session', '11.11.11.14', 'POST'));
    expect(hintCookieOf(res)).toBeUndefined();
  });

  it('POST /api/auth/signout rate-limité (429) reste possible sans crash', async () => {
    // /api/auth/signout n'a pas de limiter, mais le wrapper doit rester
    // robuste si l'upstream renvoie autre chose qu'un 200.
    upstreamPostMock.mockImplementationOnce(async () => new Response('boom', { status: 500 }));
    const { POST } = await import('@/app/api/auth/[...nextauth]/route');
    const res = await POST(buildReq('/api/auth/signout', '11.11.11.15', 'POST'));
    expect(res.status).toBe(500);
    expect(hintCookieOf(res)).toBeTruthy();
  });
});

// ─── Bypass E2E rate-limit (passage à enforceWithBypass) ─────────────────
// withRateLimit() utilise désormais `limiter.enforceWithBypass(ip, headers)`
// pour permettre aux specs e2e/staging-full de traverser sans cap.
// On vérifie le wiring ICI parce que c'est où le bypass est consommé pour
// les 3 limiters Auth.js : oauthStart, oauthCallback, credentialsLogin.
describe('Rate-limit wrapper Auth.js — bypass E2E header', () => {
  const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
  const ORIG_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;
  const BYPASS = 'n'.repeat(48);

  beforeEach(() => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.E2E_RATELIMIT_BYPASS_SECRET = BYPASS;
  });

  afterAll(() => {
    if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
    else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
    if (ORIG_SECRET === undefined) delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_SECRET;
  });

  const bypassReq = (path: string, ip: string, method: 'GET' | 'POST' = 'GET') =>
    buildReq(path, ip, method, { 'x-veridian-e2e-bypass-ratelimit': BYPASS });

  it('bypass valide en staging : 50+ signin sans 429 (oauthStartLimiter)', async () => {
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 50; i++) {
      const r = await GET(bypassReq('/api/auth/signin', '10.10.10.10'));
      expect(r.status, `req #${i}`).toBe(200);
    }
  });

  it('bypass valide en staging : 50+ callback/google sans 429 (oauthCallbackLimiter)', async () => {
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 50; i++) {
      const r = await GET(bypassReq('/api/auth/callback/google', '10.10.11.11'));
      expect(r.status, `req #${i}`).toBe(200);
    }
  });

  it('bypass valide en staging : 50+ callback/credentials sans 429 (credentialsLoginLimiter)', async () => {
    const { POST } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 50; i++) {
      const r = await POST(
        bypassReq('/api/auth/callback/credentials', '10.10.12.12', 'POST'),
      );
      expect(r.status, `req #${i}`).toBe(200);
    }
  });

  it('GARDE-FOU PROD : bypass ignoré, 11e signin → 429 (oauthStart)', async () => {
    process.env.DEPLOY_ENV = 'prod';
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 10; i++) {
      await GET(bypassReq('/api/auth/signin', '10.20.20.20'));
    }
    const blocked = await GET(bypassReq('/api/auth/signin', '10.20.20.20'));
    expect(blocked.status, 'PROD MUST ignore bypass header').toBe(429);
  });

  it('GARDE-FOU PROD : bypass ignoré, 6e callback/credentials → 429', async () => {
    process.env.DEPLOY_ENV = 'prod';
    const { POST } = await import('@/app/api/auth/[...nextauth]/route');
    for (let i = 0; i < 5; i++) {
      await POST(bypassReq('/api/auth/callback/credentials', '10.30.30.30', 'POST'));
    }
    const blocked = await POST(
      bypassReq('/api/auth/callback/credentials', '10.30.30.30', 'POST'),
    );
    expect(blocked.status, 'PROD MUST ignore bypass header').toBe(429);
  });
});
