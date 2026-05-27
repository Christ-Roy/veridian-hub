/**
 * Journey 18 — Landing cross-subdomain.
 *
 * Vérifie que les endpoints exposés au futur veridian.site (CF Pages) sont
 * câblés correctement côté Hub staging :
 *  - /api/me/lite répond 200 même sans cookie (= base contract)
 *  - OPTIONS preflight whitelist veridian.site
 *  - OPTIONS preflight refuse une origin inconnue (réponse sans Allow-Origin)
 *
 * NB : on ne teste pas le cas "authenticated" ici parce qu'on n'a pas
 * d'utilisateur staging persistant disponible. Le contrat est testé en unit
 * via __tests__/api/me/lite.test.ts.
 *
 * Sur One Tap callback : on ne peut pas tester le flow signup réel sans un
 * id_token Google valide (signé par Google, audience = vraie). On vérifie
 * juste le 401 sur token bidon — preuve que la validation cryptographique
 * tourne bien et que la route est routable.
 *
 * En staging, /api/auth/callback/google-one-tap retourne 503 (One Tap
 * désactivé sur staging Tailscale-only). On vérifie ce 503 comme garde-fou.
 */
import { test, expect } from '@playwright/test';

test.describe('Journey 18 — Landing cross-subdomain', () => {
  test('GET /api/me/lite sans cookie renvoie 200 {authenticated:false}', async ({
    request,
  }) => {
    const res = await request.get('/api/me/lite');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ authenticated: false });
  });

  test('GET /api/me/lite avec Origin whitelistée → headers CORS présents', async ({
    request,
  }) => {
    const res = await request.get('/api/me/lite', {
      headers: { Origin: 'https://veridian.site' },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['access-control-allow-origin']).toBe('https://veridian.site');
    expect(res.headers()['access-control-allow-credentials']).toBe('true');
    expect(res.headers()['vary']).toContain('Origin');
  });

  test('GET /api/me/lite avec Origin non whitelistée → pas de header Allow-Origin', async ({
    request,
  }) => {
    const res = await request.get('/api/me/lite', {
      headers: { Origin: 'https://evil.com' },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['access-control-allow-origin']).toBeUndefined();
    // Vary: Origin doit toujours être posé (anti cache poisoning)
    expect(res.headers()['vary']).toContain('Origin');
  });

  test('OPTIONS /api/me/lite preflight Origin whitelistée → 204 + Allow-Origin', async ({
    request,
  }) => {
    const res = await request.fetch('/api/me/lite', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://veridian.site',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status()).toBe(204);
    expect(res.headers()['access-control-allow-origin']).toBe('https://veridian.site');
    expect(res.headers()['access-control-allow-methods']).toContain('GET');
  });

  test('OPTIONS /api/me/lite preflight Origin inconnue → 204 sans Allow-Origin', async ({
    request,
  }) => {
    const res = await request.fetch('/api/me/lite', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status()).toBe(204);
    expect(res.headers()['access-control-allow-origin']).toBeUndefined();
  });

  test('POST /api/auth/callback/google-one-tap renvoie 503 en staging (One Tap désactivé)', async ({
    request,
  }) => {
    // Garde-fou env : staging = Tailscale-only, pas d'origin Google déclaré
    // → la route refuse tout, peu importe le body.
    const res = await request.post('/api/auth/callback/google-one-tap', {
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://veridian.site',
      },
      data: { credential: 'fake.jwt.token' },
    });
    expect(res.status()).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('disabled');
    // CORS headers posés même sur 503 (sinon la landing ne peut pas lire le body)
    expect(res.headers()['access-control-allow-origin']).toBe('https://veridian.site');
  });

  test('OPTIONS /api/auth/callback/google-one-tap preflight whitelist veridian.site', async ({
    request,
  }) => {
    const res = await request.fetch('/api/auth/callback/google-one-tap', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://veridian.site',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status()).toBe(204);
    expect(res.headers()['access-control-allow-origin']).toBe('https://veridian.site');
    expect(res.headers()['access-control-allow-methods']).toContain('POST');
  });
});
