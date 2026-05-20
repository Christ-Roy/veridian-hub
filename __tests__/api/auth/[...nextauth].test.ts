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

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const buildReq = (path: string, ip = '1.2.3.4', method: 'GET' | 'POST' = 'GET') =>
  new Request(`http://hub.test${path}`, {
    method,
    headers: { 'x-forwarded-for': ip },
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
