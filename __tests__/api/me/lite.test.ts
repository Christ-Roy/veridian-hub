/**
 * Tests pour GET /api/me/lite + OPTIONS preflight.
 *
 * Couvre Mode Nuclear :
 *  - 200 {authenticated:false} sans session
 *  - 200 {authenticated:true, email, name, image} avec session
 *  - 200 retire userId / champs internes même quand présents en session
 *  - Headers CORS posés pour origin whitelisté
 *  - Pas de header CORS pour origin non whitelisté
 *  - Vary: Origin systématique
 *  - OPTIONS preflight 204 + headers CORS
 *  - 429 quand rate-limit dépassé
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const authMock = vi.fn();

vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => authMock(...args) }));

import { GET, OPTIONS } from '@/app/api/me/lite/route';

function makeReq(origin?: string, ip = '203.0.113.1'): NextRequest {
  const headers = new Headers({ 'x-forwarded-for': ip });
  if (origin) headers.set('origin', origin);
  // NextRequest construit dans Node Fetch (undici) strip les "forbidden
  // header names" (origin, host, cookie). En prod côté browser/edge ces
  // headers passent — en tests on doit réinjecter via Object.defineProperty
  // pour simuler le comportement runtime.
  const req = new NextRequest('http://localhost/api/me/lite', { headers });
  Object.defineProperty(req, 'headers', { value: headers, configurable: true });
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset l'env pour éviter pollution entre tests.
  delete process.env.LANDING_ORIGIN;
  delete process.env.LANDING_ORIGIN_STAGING;
  process.env.DEPLOY_ENV = 'prod';
});

describe('GET /api/me/lite', () => {
  it('retourne 200 {authenticated:false} sans session', async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(makeReq('https://veridian.site'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ authenticated: false });
  });

  it('retourne 200 + claims user avec session active', async () => {
    authMock.mockResolvedValue({
      user: {
        id: 'user-internal-id-secret',
        email: 'robert@veridian.site',
        name: 'Robert',
        image: 'https://cdn/avatar.png',
      },
    });
    const res = await GET(makeReq('https://veridian.site'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      authenticated: true,
      email: 'robert@veridian.site',
      name: 'Robert',
      image: 'https://cdn/avatar.png',
    });
  });

  it('ne leak PAS le userId (pas dans body même si session le contient)', async () => {
    authMock.mockResolvedValue({
      user: {
        id: 'user-internal-id-secret',
        email: 'robert@veridian.site',
      },
    });
    const res = await GET(makeReq('https://veridian.site'));
    const body = await res.json();
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('userId');
    expect(JSON.stringify(body)).not.toContain('user-internal-id-secret');
  });

  it('email manquant en session = {authenticated:false}', async () => {
    authMock.mockResolvedValue({ user: { id: 'x' } });
    const res = await GET(makeReq('https://veridian.site'));
    const body = await res.json();
    expect(body).toEqual({ authenticated: false });
  });

  it('pose Access-Control-Allow-Origin: <origin> pour origin whitelisté', async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(makeReq('https://veridian.site'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://veridian.site');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('ne pose PAS Allow-Origin pour origin non whitelisté', async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(makeReq('https://evil.com'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    // Mais Vary: Origin toujours présent
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('pose Vary: Origin même sans header origin (anti-cache empoisonnement)', async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(makeReq(undefined));
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('OPTIONS /api/me/lite preflight', () => {
  it('204 + headers CORS pour origin whitelisté', async () => {
    const res = await OPTIONS(makeReq('https://veridian.site'));
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://veridian.site');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
  });

  it('204 sans Allow-Origin pour origin rejeté', async () => {
    const res = await OPTIONS(makeReq('https://evil.com'));
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('rate limit /api/me/lite', () => {
  it('429 après >100 hits/min/IP avec Retry-After', async () => {
    authMock.mockResolvedValue(null);
    // 100 premiers = OK
    for (let i = 0; i < 100; i++) {
      const res = await GET(makeReq('https://veridian.site', '203.0.113.99'));
      expect(res.status).toBe(200);
    }
    // 101ᵉ = 429
    const blocked = await GET(makeReq('https://veridian.site', '203.0.113.99'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    const body = await blocked.json();
    expect(body.authenticated).toBe(false);
    expect(body.error).toBe('rate_limited');
    // CORS posé même sur 429
    expect(blocked.headers.get('Access-Control-Allow-Origin')).toBe('https://veridian.site');
  });
});
