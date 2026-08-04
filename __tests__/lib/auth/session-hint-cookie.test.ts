/**
 * Tests pour le cookie hint cross-subdomain `veridian-session-hint`.
 *
 * Couvre Mode Nuclear :
 *  - encode + decode round-trip
 *  - signature falsifiée → null (silencieux, ne throw pas)
 *  - exp dépassé → null
 *  - issuer mismatch → null
 *  - JSON malformé → null
 *  - SESSION_HINT_SECRET absent → throw à l'encode, null au decode
 *  - SESSION_HINT_SECRET < 32 chars → throw / null
 *  - setSessionHintCookie pose le bon Set-Cookie (HttpOnly:false, scope,
 *    SameSite:Lax, Max-Age 30j)
 *  - clearSessionHintCookie pose Max-Age 0
 *  - readSessionHintFromRequest lit + valide depuis NextRequest
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import { SignJWT } from 'jose';

import {
  SESSION_HINT_COOKIE_NAME,
  SESSION_HINT_TTL_S,
  encodeSessionHintJwt,
  decodeSessionHintJwt,
  setSessionHintCookie,
  clearSessionHintCookie,
  buildClearedSessionHintSetCookie,
  readSessionHintFromRequest,
} from '@/lib/auth/session-hint-cookie';

const TEST_SECRET = 'x'.repeat(48);

beforeEach(() => {
  process.env.SESSION_HINT_SECRET = TEST_SECRET;
  process.env.NODE_ENV = 'production';
  process.env.DEPLOY_ENV = 'prod';
});

describe('encodeSessionHintJwt + decodeSessionHintJwt round-trip', () => {
  it('round-trip claims email/name/image', async () => {
    const jwt = await encodeSessionHintJwt({
      email: 'robert@veridian.site',
      name: 'Robert',
      image: 'https://cdn/avatar.png',
    });
    const decoded = await decodeSessionHintJwt(jwt);
    expect(decoded).toEqual({
      email: 'robert@veridian.site',
      name: 'Robert',
      image: 'https://cdn/avatar.png',
    });
  });

  it('round-trip avec name/image absents (normalisés à null)', async () => {
    const jwt = await encodeSessionHintJwt({ email: 'a@b.com' });
    const decoded = await decodeSessionHintJwt(jwt);
    expect(decoded).toEqual({ email: 'a@b.com', name: null, image: null });
  });
});

describe('decodeSessionHintJwt — defenses', () => {
  it('renvoie null si signature falsifiée (mauvais secret)', async () => {
    const jwt = await encodeSessionHintJwt({ email: 'a@b.com' });
    // Re-sign avec un autre secret
    const otherSecret = 'y'.repeat(48);
    process.env.SESSION_HINT_SECRET = otherSecret;
    const decoded = await decodeSessionHintJwt(jwt);
    expect(decoded).toBeNull();
  });

  it('renvoie null si JWT expiré', async () => {
    // Forge un JWT avec exp dans le passé
    const expired = await new SignJWT({ email: 'a@b.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('veridian-hub')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(TEST_SECRET));
    const decoded = await decodeSessionHintJwt(expired);
    expect(decoded).toBeNull();
  });

  it('renvoie null si issuer mismatch (anti-token recyclé d\'un autre service)', async () => {
    const otherIssuer = await new SignJWT({ email: 'a@b.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('not-veridian')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode(TEST_SECRET));
    const decoded = await decodeSessionHintJwt(otherIssuer);
    expect(decoded).toBeNull();
  });

  it('renvoie null si JSON malformé / pas un JWT', async () => {
    expect(await decodeSessionHintJwt('not-a-jwt')).toBeNull();
    expect(await decodeSessionHintJwt('aa.bb.cc')).toBeNull();
    expect(await decodeSessionHintJwt('')).toBeNull();
  });

  it('renvoie null si email absent du payload', async () => {
    const noEmail = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('veridian-hub')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode(TEST_SECRET));
    const decoded = await decodeSessionHintJwt(noEmail);
    expect(decoded).toBeNull();
  });
});

describe('SESSION_HINT_SECRET garde-fous', () => {
  it('encode throw si SESSION_HINT_SECRET absent', async () => {
    delete process.env.SESSION_HINT_SECRET;
    await expect(encodeSessionHintJwt({ email: 'a@b.com' })).rejects.toThrow(
      /SESSION_HINT_SECRET/,
    );
  });

  it('encode throw si SESSION_HINT_SECRET < 32 chars', async () => {
    process.env.SESSION_HINT_SECRET = 'too-short';
    await expect(encodeSessionHintJwt({ email: 'a@b.com' })).rejects.toThrow();
  });

  it('decode renvoie null (silencieux) si SESSION_HINT_SECRET absent', async () => {
    // Forge un JWT valide d'abord
    const jwt = await encodeSessionHintJwt({ email: 'a@b.com' });
    // Puis retire le secret
    delete process.env.SESSION_HINT_SECRET;
    const decoded = await decodeSessionHintJwt(jwt);
    expect(decoded).toBeNull();
  });
});

describe('setSessionHintCookie', () => {
  it('pose un cookie HttpOnly:false (lisible JS), Domain=.veridian.site, Secure, SameSite=Lax', async () => {
    const res = NextResponse.json({});
    await setSessionHintCookie(res, {
      email: 'robert@veridian.site',
      name: 'Robert',
      image: null,
    });
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain(`${SESSION_HINT_COOKIE_NAME}=`);
    expect(setCookie).toContain('Domain=.veridian.site');
    expect(setCookie).toContain('SameSite=lax');
    expect(setCookie).toContain('Secure');
    expect(setCookie).not.toContain('HttpOnly'); // PUBLIC volontairement
    expect(setCookie).toContain(`Max-Age=${SESSION_HINT_TTL_S}`);
  });

  it('scope .staging.veridian.site en staging', async () => {
    process.env.DEPLOY_ENV = 'staging';
    const res = NextResponse.json({});
    await setSessionHintCookie(res, { email: 'a@b.com' });
    expect(res.headers.get('set-cookie')).toContain('Domain=.staging.veridian.site');
  });

  it('pas de Domain en local-dev (DEPLOY_ENV absent)', async () => {
    delete process.env.DEPLOY_ENV;
    process.env.NODE_ENV = 'development';
    const res = NextResponse.json({});
    await setSessionHintCookie(res, { email: 'a@b.com' });
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).not.toContain('Domain=');
    expect(setCookie).not.toContain('Secure');
  });
});

describe('clearSessionHintCookie', () => {
  it('pose un cookie avec Max-Age=0 (suppression)', () => {
    const res = NextResponse.json({});
    clearSessionHintCookie(res);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${SESSION_HINT_COOKIE_NAME}=;`);
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('Domain=.veridian.site');
  });
});

// Utilisé pour greffer la suppression sur une réponse qu'on ne construit pas
// (celle du signOut Auth.js). Le format DOIT rester identique à celui posé
// par clearSessionHintCookie, sinon le navigateur ne matche pas le cookie à
// supprimer (domaine ou path différent = nouveau cookie, l'ancien survit).
describe('buildClearedSessionHintSetCookie', () => {
  it('rend une valeur Set-Cookie de suppression exploitable telle quelle', () => {
    const cookie = buildClearedSessionHintSetCookie();
    expect(cookie).toContain(`${SESSION_HINT_COOKIE_NAME}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Domain=.veridian.site');
    expect(cookie).toContain('Path=/');
  });

  it('produit exactement le même cookie que clearSessionHintCookie', () => {
    const res = NextResponse.json({});
    clearSessionHintCookie(res);
    expect(buildClearedSessionHintSetCookie()).toBe(res.headers.get('set-cookie'));
  });

  it('suit le scope staging quand DEPLOY_ENV=staging', () => {
    expect(buildClearedSessionHintSetCookie({ ...process.env, DEPLOY_ENV: 'staging' })).toContain(
      'Domain=.staging.veridian.site',
    );
  });
});

describe('readSessionHintFromRequest', () => {
  function makeReqWithCookie(name: string, value: string): NextRequest {
    // NextRequest en test ne parse pas le header `cookie` (undici strip).
    // On utilise l'API `req.cookies.set()` qui fonctionne.
    const req = new NextRequest('http://localhost/x');
    req.cookies.set(name, value);
    return req;
  }

  it('lit et retourne les claims si cookie présent + JWT valide', async () => {
    const jwt = await encodeSessionHintJwt({
      email: 'robert@veridian.site',
      name: 'Robert',
    });
    const req = makeReqWithCookie(SESSION_HINT_COOKIE_NAME, jwt);
    const claims = await readSessionHintFromRequest(req);
    expect(claims).toEqual({
      email: 'robert@veridian.site',
      name: 'Robert',
      image: null,
    });
  });

  it('renvoie null si pas de cookie', async () => {
    const req = new NextRequest('http://localhost/x');
    expect(await readSessionHintFromRequest(req)).toBeNull();
  });

  it('renvoie null si JWT invalide dans le cookie', async () => {
    const req = makeReqWithCookie(SESSION_HINT_COOKIE_NAME, 'garbage');
    expect(await readSessionHintFromRequest(req)).toBeNull();
  });
});
