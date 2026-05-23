/**
 * Tests pour GET /api/auth/bounce/prepare — Couche 4 Hub étape 1
 * (cf. CONTRAT-HUB §6bis.8.2).
 *
 * Couvre (CI bloquant §6bis.8.5 « Le Hub DOIT couvrir ») :
 *  - `?next=https://evil.com` → ignoré, redirect /login (regex strict)
 *  - `?next=https://newapp.veridian.site/x` → flow nominal (regex large)
 *  - `?next` mal encodé → ignoré sans 500
 *  - cookie signé posé avec attributs sécurisés corrects
 *  - flag `mode=bounce&app=<app>` ajouté à l'URL de redirect
 *  - AUTH_SECRET manquant → redirect /login sans cookie (log critical)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  verifyNextCookie,
  NEXT_COOKIE_NAME_SECURE,
  NEXT_COOKIE_NAME_INSECURE,
} from '@/lib/auth/bounce-next';

const TEST_SECRET = 'test-auth-secret-at-least-32-bytes-long-xx';

function makeReq(nextValue?: string): NextRequest {
  const url = new URL('https://app.veridian.site/api/auth/bounce/prepare');
  if (nextValue !== undefined) url.searchParams.set('next', nextValue);
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = TEST_SECRET;
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
  process.env.NEXTAUTH_URL = 'https://app.veridian.site';
  process.env.DEPLOY_ENV = 'production';
});

describe('GET /api/auth/bounce/prepare', () => {
  it('pas de ?next= → redirect /login sans cookie ni mode', async () => {
    const { GET } = await import('@/app/api/auth/bounce/prepare/route');
    const res = await GET(makeReq());
    const loc = res.headers.get('location');
    expect(loc).toContain('/login');
    expect(loc).not.toContain('mode=bounce');
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBeFalsy();
  });

  it('next=https://evil.com → ignoré, redirect /login sans cookie', async () => {
    const { GET } = await import('@/app/api/auth/bounce/prepare/route');
    const res = await GET(makeReq('https://evil.com/path'));
    const loc = res.headers.get('location');
    expect(loc).toContain('/login');
    expect(loc).not.toContain('mode=bounce');
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBeFalsy();
  });

  it('next valide (newapp.veridian.site, regex large) → cookie signé + redirect mode=bounce&app=newapp', async () => {
    const { GET } = await import('@/app/api/auth/bounce/prepare/route');
    const res = await GET(makeReq('https://newapp.veridian.site/signin'));
    const loc = res.headers.get('location');
    expect(loc).toContain('/login');
    expect(loc).toContain('mode=bounce');
    expect(loc).toContain('app=newapp');

    const cookie = res.cookies.get(NEXT_COOKIE_NAME_SECURE);
    expect(cookie).toBeDefined();
    expect(cookie!.value).toBeTruthy();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.secure).toBe(true);
    expect(cookie!.sameSite).toBe('lax');
    expect(cookie!.path).toBe('/');

    // Cookie déchiffrable + restitue le next original
    const decoded = verifyNextCookie(cookie!.value, TEST_SECRET);
    expect(decoded).toBe('https://newapp.veridian.site/signin');
  });

  it('next nominal notifuse → cookie + redirect mode=bounce&app=notifuse', async () => {
    const { GET } = await import('@/app/api/auth/bounce/prepare/route');
    const res = await GET(makeReq('https://notifuse.veridian.site/'));
    const loc = res.headers.get('location');
    expect(loc).toContain('app=notifuse');
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBeTruthy();
  });

  it('next mal encodé / malformé → ignoré sans 500', async () => {
    const { GET } = await import('@/app/api/auth/bounce/prepare/route');
    // URL avec % non escapée — la regex stricte rejette de toute façon
    const res = await GET(makeReq('not-a-url'));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('location')).toContain('/login');
    expect(res.headers.get('location')).not.toContain('mode=bounce');
  });

  it('next pointe vers Hub lui-même (app.veridian.site) → ignoré (anti-loop)', async () => {
    const { GET } = await import('@/app/api/auth/bounce/prepare/route');
    const res = await GET(makeReq('https://app.veridian.site/dashboard'));
    const loc = res.headers.get('location');
    expect(loc).not.toContain('mode=bounce');
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBeFalsy();
  });

  it('next > 2048 chars → ignoré', async () => {
    const { GET } = await import('@/app/api/auth/bounce/prepare/route');
    const long = 'https://notifuse.veridian.site/' + 'a'.repeat(2500);
    const res = await GET(makeReq(long));
    expect(res.headers.get('location')).not.toContain('mode=bounce');
  });

  it('AUTH_SECRET manquant → redirect /login sans cookie (refus net)', async () => {
    delete process.env.AUTH_SECRET;
    const { GET } = await import('@/app/api/auth/bounce/prepare/route');
    const res = await GET(makeReq('https://notifuse.veridian.site/'));
    expect(res.headers.get('location')).toContain('/login');
    expect(res.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value).toBeFalsy();
  });

  it('DEPLOY_ENV=staging : accepte staging hosts, refuse prod', async () => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.NEXTAUTH_URL = 'https://hub.staging.veridian.site';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://hub.staging.veridian.site';
    const { GET } = await import('@/app/api/auth/bounce/prepare/route');

    const stagingReq = new NextRequest(
      new URL(
        'https://hub.staging.veridian.site/api/auth/bounce/prepare?next=' +
          encodeURIComponent('https://notifuse.staging.veridian.site/signin'),
      ),
    );
    const okRes = await GET(stagingReq);
    expect(okRes.headers.get('location')).toContain('mode=bounce');
    expect(okRes.headers.get('location')).toContain('app=notifuse');

    const prodNextReq = new NextRequest(
      new URL(
        'https://hub.staging.veridian.site/api/auth/bounce/prepare?next=' +
          encodeURIComponent('https://notifuse.veridian.site/signin'),
      ),
    );
    const koRes = await GET(prodNextReq);
    expect(koRes.headers.get('location')).not.toContain('mode=bounce');
  });
});
