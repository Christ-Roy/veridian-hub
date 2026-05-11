/**
 * Auth guards — protected routes redirect when unauthenticated.
 *
 * Le middleware Auth.js (`middleware.ts` + `authConfig.callbacks.authorized`)
 * doit rediriger toute requête non-auth vers `/login?callbackUrl=<original>`
 * pour :
 *  - /dashboard (et ses sous-routes)
 *  - /admin (et ses sous-routes)
 *
 * Les pages publiques (/, /pricing, /legal, /login, /signup, /api/*) ne
 * doivent PAS rediriger.
 *
 * Si le middleware est cassé ou que `authConfig.authorized` retourne
 * `true` par erreur sur une route protégée, on a une fuite d'auth grave.
 * Ce spec est le filet de sécurité.
 */
import { test, expect } from '@playwright/test';

const HUB_URL = process.env.HUB_URL || 'http://localhost:3000';

test.describe('Auth guards on protected routes', () => {
  test('/dashboard unauthenticated redirects to /login with callbackUrl', async ({ page }) => {
    // Disable redirect following so we can inspect the 307 directly.
    const response = await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'commit' });
    // After redirect, the final URL must be /login with callbackUrl param.
    await page.waitForURL(/\/login\?.*callbackUrl=/, { timeout: 5_000 });
    expect(page.url(), 'should land on /login with callbackUrl').toMatch(
      /\/login\?.*callbackUrl=.*dashboard/
    );
    expect(response?.status(), 'initial response should be a 3xx, not 200').toBeLessThan(400);
  });

  test('/admin unauthenticated redirects to /login with callbackUrl', async ({ page }) => {
    await page.goto(`${HUB_URL}/admin`, { waitUntil: 'commit' });
    await page.waitForURL(/\/login\?.*callbackUrl=/, { timeout: 5_000 });
    expect(page.url(), 'should land on /login with callbackUrl').toMatch(
      /\/login\?.*callbackUrl=.*admin/
    );
  });

  test('/ (marketing root) is accessible without auth', async ({ page }) => {
    const response = await page.goto(`${HUB_URL}/`);
    expect(response?.status(), 'public / should return 200').toBe(200);
    expect(page.url(), 'should stay on /').toMatch(/^https?:\/\/[^/]+\/?$/);
  });

  test('/pricing is accessible without auth', async ({ page }) => {
    const response = await page.goto(`${HUB_URL}/pricing`);
    expect(response?.status(), 'public /pricing should return 200').toBe(200);
    expect(page.url()).toContain('/pricing');
  });
});
