/**
 * Prod smoke — Hub Auth.js endpoints.
 *
 * **CET UNIQUE SPEC AURAIT DÉTECTÉ L'INCIDENT 2026-05-10 EN 30s.**
 *
 * Lancé par hub-ci.yml après chaque deploy prod. Si fail → rollback auto.
 * Aucune écriture, aucune signup. Read-only contre app.veridian.site.
 *
 * Pourquoi un fichier séparé du core/:
 *   - core/ s'exécute contre staging (parfois en panne, parfois en cours de
 *     deploy — tolérable). prod-smoke/ tape la PROD avec exigence absolue.
 *   - Pas de retry en prod-smoke : 1 fail = rollback. On veut pas masquer.
 */
import { test, expect } from '@playwright/test';

// Hard-coded prod URL by design: ce spec doit TOUJOURS taper app.veridian.site
// même si HUB_URL pointe ailleurs (staging) — c'est le gate de prod.
const PROD_HUB_URL = 'https://app.veridian.site';

test.describe('Hub PROD /api/auth/* smoke', () => {
  // Hard fail-fast — pas de retry sur prod smoke (sauf si CI force).
  // Le retry global Playwright (2 en CI) reste actif au cas où le réseau
  // décroche entre OVH et le runner GitHub, mais une vraie 500 doit fail.

  test('PROD /api/auth/providers returns google + credentials', async ({ request }) => {
    const res = await request.get(`${PROD_HUB_URL}/api/auth/providers`);
    expect(res.status(), 'prod /api/auth/providers MUST return 200').toBe(200);
    const body = await res.json();
    expect(body, 'prod providers must have google + credentials').toEqual(
      expect.objectContaining({
        // Auth.js v5 reports Google as type "oidc" (it derives from the
        // discovery doc), not "oauth". Don't be fooled by docs that show
        // "oauth" — it's the v4 shape.
        google: expect.objectContaining({ id: 'google', type: 'oidc' }),
        credentials: expect.objectContaining({ id: 'credentials', type: 'credentials' }),
      })
    );
  });

  test('PROD /api/auth/csrf returns a token', async ({ request }) => {
    const res = await request.get(`${PROD_HUB_URL}/api/auth/csrf`);
    expect(res.status(), 'prod /api/auth/csrf MUST return 200').toBe(200);
    const body = await res.json();
    expect(typeof body.csrfToken).toBe('string');
    expect(body.csrfToken.length).toBeGreaterThan(10);
  });

  test('PROD /api/auth/session returns null user when unauthenticated', async ({ request }) => {
    const res = await request.get(`${PROD_HUB_URL}/api/auth/session`);
    expect(res.status(), 'prod /api/auth/session MUST return 200').toBe(200);
    const body = await res.json();
    expect(body?.user ?? null).toBeNull();
  });

  test('PROD /login renders without 5xx', async ({ page }) => {
    // We don't assert form fields here (covered by core/login-page.spec.ts
    // against staging). On prod we just want zero 5xx and a non-empty body.
    const response = await page.goto(`${PROD_HUB_URL}/login`);
    const status = response?.status() ?? 0;
    expect(status, `prod /login returned ${status}, expected 2xx`).toBeLessThan(400);

    // Non-blank body
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.length, 'prod /login body should not be blank').toBeGreaterThan(50);
  });
});
