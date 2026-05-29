/**
 * Journey 1 — Health + routes publiques.
 *
 * Vérifie que les fondations staging sont solides AVANT d'attaquer les flows
 * qui dépendent de l'app rendue correctement.
 */
import { test, expect } from '@playwright/test';

test.describe('Journey 1 — Fondations', () => {
  test('GET /api/health renvoie 200', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
  });

  test('GET / redirige le visiteur non-loggué vers le site marketing (depuis 2026-05-29)', async ({
    request,
  }) => {
    // La home n'est plus une landing : elle redirige (307) vers veridian.site
    // pour un visiteur non-loggué (loggué → /dashboard). On vérifie la redirect
    // SANS la suivre — sinon on testerait veridian.site, hors périmètre Hub
    // (et l'ancien test "titre Veridian" passait par accident sur la cible).
    const res = await request.get('/', { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()['location'] ?? '').toContain('veridian.site');
  });

  test('GET /login affiche le form Credentials (OAuth désactivé en staging Tailscale-only)', async ({ page }) => {
    const res = await page.goto('/login');
    expect(res?.status()).toBe(200);
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    // En staging, OAuth Google/Microsoft sont désactivés (cf. journey 2).
  });

  test('GET /signup affiche le form Credentials (OAuth désactivé en staging)', async ({ page }) => {
    const res = await page.goto('/signup');
    expect(res?.status()).toBe(200);
    await expect(page.locator('input[name="email"]')).toBeVisible();
  });

  test('GET /legal (Privacy + Terms) accessible publiquement', async ({ page }) => {
    const res = await page.goto('/legal');
    expect(res?.status()).toBe(200);
    await expect(page.getByText(/Politique de Confidentialité|Privacy/i).first()).toBeVisible();
  });

  test('GET /dashboard sans session redirect vers /login', async ({ page }) => {
    const res = await page.goto('/dashboard');
    // Soit 302 vers /login, soit la page /login s'affiche (URL finale doit contenir /login)
    expect(page.url()).toMatch(/\/login/);
    expect(res?.status()).toBeLessThan(500);
  });
});
