/**
 * Auth.js endpoints smoke — protection contre l'incident 2026-05-10.
 *
 * Ce matin-là (cf docs/infra/INCIDENT-2026-05-10-hub-traefik-collision.md)
 * un container fantôme du compose pre-Auth.js avait pris la main sur
 * `app.veridian.site`. Toutes les routes /api/auth/* renvoyaient 500
 * pendant 3h sans qu'aucun test ne le détecte.
 *
 * Ce spec valide les 3 endpoints publics de Auth.js v5 :
 *
 *  - GET /api/auth/providers → liste les providers configurés
 *      Doit contenir google + (en mode credentials enabled) credentials.
 *      Cf auth.config.ts (edge) + auth.ts (Node, ajoute Credentials).
 *
 *  - GET /api/auth/csrf → renvoie { csrfToken: string }
 *      Premier appel d'un client legit. Si broken → impossible de POST
 *      /api/auth/callback/credentials.
 *
 *  - GET /api/auth/session → renvoie un objet user ou {} si pas connecté
 *      Sans cookie : doit retourner {} (200), pas 401 ni 500. Tout le
 *      reste de l'app appelle ça via useSession() côté client.
 *
 * Si l'un de ces 3 endpoints fail → bloque le deploy (rollback prod).
 */
import { test, expect } from '@playwright/test';

const HUB_URL = process.env.HUB_URL || 'http://localhost:3000';

test.describe('Auth.js /api/auth/* smoke', () => {
  test('GET /api/auth/providers returns 200 with expected providers', async ({ request }) => {
    const res = await request.get(`${HUB_URL}/api/auth/providers`);
    expect(res.status(), `Expected 200 on /api/auth/providers, got ${res.status()}`).toBe(200);

    const body = await res.json();
    // body is a record keyed by provider id (e.g. { google: {...}, credentials: {...} }).
    // We require at minimum 'google' since it's defined in the edge-safe
    // auth.config.ts. 'credentials' lives in auth.ts (Node-only) and is the
    // legacy email/password flow — its presence proves the full Node auth
    // module was loaded successfully (incident d'aujourd'hui : ça crashait).
    expect(body, 'providers body should be an object').toBeTruthy();
    expect(Object.keys(body).length, 'at least one provider must be configured').toBeGreaterThan(0);

    // Hard assertions on the actual providers we ship in prod.
    expect(body, JSON.stringify(body, null, 2)).toHaveProperty('google');
    expect(body.google).toMatchObject({
      id: 'google',
      // Auth.js v5 normalizes Google to "oidc" via the discovery doc.
      type: 'oidc',
    });

    // Credentials provider is added only in auth.ts (Node), so its presence
    // confirms the Node-side init didn't crash. THIS is the canary for the
    // incident d'aujourd'hui.
    expect(body, JSON.stringify(body, null, 2)).toHaveProperty('credentials');
    expect(body.credentials).toMatchObject({
      id: 'credentials',
      type: 'credentials',
    });
  });

  test('GET /api/auth/csrf returns 200 with csrfToken', async ({ request }) => {
    const res = await request.get(`${HUB_URL}/api/auth/csrf`);
    expect(res.status(), `Expected 200 on /api/auth/csrf, got ${res.status()}`).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('csrfToken');
    expect(typeof body.csrfToken, 'csrfToken should be a non-empty string').toBe('string');
    expect(body.csrfToken.length).toBeGreaterThan(10);
  });

  test('GET /api/auth/session returns 200 with empty body when not signed in', async ({
    request,
  }) => {
    // No cookie attached → Auth.js should return 200 with {} (not 401, not
    // 500). The client-side useSession() relies on this contract.
    const res = await request.get(`${HUB_URL}/api/auth/session`);
    expect(res.status(), `Expected 200 on /api/auth/session, got ${res.status()}`).toBe(200);

    const body = await res.json();
    // Body is either {} or { user: null/undefined, expires: ... } — either
    // way it must NOT contain a real user when no cookie is provided.
    expect(body?.user ?? null, 'unauthenticated session should have no user').toBeNull();
  });
});
