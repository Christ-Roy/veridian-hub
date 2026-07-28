/**
 * Tests pour GET /api/me/lite + OPTIONS preflight.
 *
 * Couvre Mode Nuclear :
 *  - Fast path hint cookie : 200 {source:'hint'} sans appeler auth()
 *  - Fallback Auth.js : 200 {source:'session'} si pas de hint mais session OK
 *  - Bootstrap hint : pose le cookie hint quand fallback Auth.js réussit
 *  - 200 {authenticated:false} sans session ni hint
 *  - 200 retire userId / champs internes même quand présents en session
 *  - Headers CORS posés pour origin whitelisté
 *  - Pas de header CORS pour origin non whitelisté
 *  - Vary: Origin systématique
 *  - OPTIONS preflight 204 + headers CORS
 *  - 429 quand rate-limit dépassé
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));

vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => authMock(...args) }));

import { GET, OPTIONS } from '@/app/api/me/lite/route';
import { SESSION_HINT_COOKIE_NAME } from '@/lib/auth/session-hint-cookie';
import { resolveSessionCookieName } from '@/lib/auth/cookie-scope';

const TEST_HINT_SECRET = 'h'.repeat(48);

async function makeHintJwt(email: string, extra?: { name?: string; image?: string }) {
  return new SignJWT({
    email,
    name: extra?.name ?? null,
    image: extra?.image ?? null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('veridian-hub')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(TEST_HINT_SECRET));
}

function makeReq(
  origin?: string,
  ip = '203.0.113.1',
  hintCookieValue?: string,
  opts: { sessionCookie?: boolean } = {},
): NextRequest {
  const headers = new Headers({ 'x-forwarded-for': ip });
  if (origin) headers.set('origin', origin);
  const req = new NextRequest('http://localhost/api/me/lite', { headers });
  // NextRequest strip les "forbidden headers" (origin) en undici — réinjecte.
  Object.defineProperty(req, 'headers', { value: headers, configurable: true });
  // Le header `cookie` n'est pas non plus préservé par undici — on utilise
  // l'API `req.cookies.set()` qui fonctionne en test.
  if (hintCookieValue) {
    req.cookies.set(SESSION_HINT_COOKIE_NAME, hintCookieValue);
  }
  // Un navigateur réellement connecté envoie TOUJOURS le cookie session avec
  // le hint (même site) — c'est la situation par défaut dès qu'un hint est
  // présent. Passer `sessionCookie: false` simule le hint orphelin qui
  // survit à une déconnexion.
  const wantsSessionCookie = opts.sessionCookie ?? Boolean(hintCookieValue);
  if (wantsSessionCookie) {
    req.cookies.set(resolveSessionCookieName(), 'fake-session-jwe');
  }
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LANDING_ORIGIN;
  delete process.env.LANDING_ORIGIN_STAGING;
  process.env.DEPLOY_ENV = 'prod';
  process.env.NODE_ENV = 'production';
  process.env.SESSION_HINT_SECRET = TEST_HINT_SECRET;
});

describe('GET /api/me/lite — fast path hint cookie', () => {
  it("retourne 200 {source:'hint'} sans toucher à auth()", async () => {
    const jwt = await makeHintJwt('robert@veridian.site', {
      name: 'Robert',
      image: 'https://cdn/img.png',
    });
    const res = await GET(makeReq('https://veridian.site', '203.0.113.1', jwt));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      authenticated: true,
      email: 'robert@veridian.site',
      name: 'Robert',
      image: 'https://cdn/img.png',
      source: 'hint',
    });
    expect(authMock).not.toHaveBeenCalled();
  });

  it('hint cookie invalide → fallback Auth.js (PAS de 401 silencieux)', async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(makeReq('https://veridian.site', '203.0.113.1', 'garbage'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ authenticated: false });
    expect(authMock).toHaveBeenCalled();
  });
});

// ─── Non-régression : le hint ne doit plus être auto-confirmant ───────────
// Bug : le signOut Auth.js ne supprimait pas le hint (TTL 30j). Le fast path
// le validait sans autre vérification → la landing veridian.site affichait
// "Mon compte" pendant un mois après déconnexion, et One Tap ne se déclenchait
// plus jamais. Le hint n'est qu'un cache d'affichage : sans cookie session, il
// est périmé par définition.
describe('GET /api/me/lite — hint orphelin (sans cookie session)', () => {
  it('hint valide MAIS aucun cookie session → {authenticated:false}', async () => {
    authMock.mockResolvedValue(null);
    const jwt = await makeHintJwt('robert@veridian.site', { name: 'Robert' });
    const res = await GET(
      makeReq('https://veridian.site', '203.0.113.2', jwt, { sessionCookie: false }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it('auto-répare : supprime le hint orphelin (Max-Age=0, bon scope)', async () => {
    authMock.mockResolvedValue(null);
    const jwt = await makeHintJwt('robert@veridian.site');
    const res = await GET(
      makeReq('https://veridian.site', '203.0.113.3', jwt, { sessionCookie: false }),
    );
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('veridian-session-hint=;');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('Domain=.veridian.site');
  });

  it('garde les headers CORS sur la réponse de correction', async () => {
    authMock.mockResolvedValue(null);
    const jwt = await makeHintJwt('robert@veridian.site');
    const res = await GET(
      makeReq('https://veridian.site', '203.0.113.4', jwt, { sessionCookie: false }),
    );
    // Sans Allow-Credentials, le navigateur ignorerait le Set-Cookie de
    // suppression sur une réponse cross-origin → hint jamais nettoyé.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://veridian.site');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('cookie session chunké (.0/.1) → le fast path reste valide', async () => {
    const jwt = await makeHintJwt('robert@veridian.site');
    const req = makeReq('https://veridian.site', '203.0.113.5', jwt, {
      sessionCookie: false,
    });
    // Auth.js éclate le cookie au-delà de 4 ko : ne matcher que le nom exact
    // déconnecterait à tort les grosses sessions.
    req.cookies.set(`${resolveSessionCookieName()}.0`, 'chunk-0');
    req.cookies.set(`${resolveSessionCookieName()}.1`, 'chunk-1');
    const res = await GET(req);
    expect(await res.json()).toMatchObject({ authenticated: true, source: 'hint' });
    expect(authMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/me/lite — fallback session Auth.js', () => {
  it("retourne 200 {source:'session'} si pas de hint mais session OK", async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', email: 'robert@veridian.site', name: 'Robert', image: null },
    });
    const res = await GET(makeReq('https://veridian.site'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      authenticated: true,
      email: 'robert@veridian.site',
      source: 'session',
    });
  });

  it('bootstrap : pose le cookie hint quand fallback Auth.js réussit', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', email: 'robert@veridian.site', name: 'Robert', image: null },
    });
    const res = await GET(makeReq('https://veridian.site'));
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('veridian-session-hint=');
    expect(setCookie).toContain('Domain=.veridian.site');
  });

  it('retourne 200 {authenticated:false} sans session ni hint', async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(makeReq('https://veridian.site'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ authenticated: false });
  });

  it('ne leak PAS le userId (pas dans body même si session le contient)', async () => {
    authMock.mockResolvedValue({
      user: { id: 'user-internal-id-secret', email: 'robert@veridian.site' },
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
    expect((await res.json())).toEqual({ authenticated: false });
  });
});

describe('GET /api/me/lite — CORS', () => {
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
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('pose Vary: Origin même sans header origin', async () => {
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
    for (let i = 0; i < 100; i++) {
      const res = await GET(makeReq('https://veridian.site', '203.0.113.99'));
      expect(res.status).toBe(200);
    }
    const blocked = await GET(makeReq('https://veridian.site', '203.0.113.99'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    const body = await blocked.json();
    expect(body.authenticated).toBe(false);
    expect(body.error).toBe('rate_limited');
    expect(blocked.headers.get('Access-Control-Allow-Origin')).toBe('https://veridian.site');
  });
});
