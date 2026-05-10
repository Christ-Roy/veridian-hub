/**
 * /login page render — smoke spec.
 *
 * Vérifie que la page de login Hub rend correctement post-Auth.js migration:
 *  - HTTP 200 (pas 500 — cf incident 2026-05-10)
 *  - Champs email + password visibles (LoginForm via auth.config.ts allowEmail)
 *  - Bouton "Continuer avec Google" présent (allowOauth)
 *  - Bouton submit visible
 *  - Aucune console error JS sur le chargement initial
 *
 * Cette page est le point d'entrée pour tout user qui veut accéder au
 * dashboard. Si elle est cassée, plus personne ne se connecte.
 */
import { test, expect, type ConsoleMessage } from '@playwright/test';

const HUB_URL = process.env.HUB_URL || 'http://localhost:3000';

let consoleErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    // Filtrer le bruit non-actionnable
    if (t.includes('GTM') || t.includes('dataLayer') || t.includes('favicon')) return;
    if (t.includes('Failed to load resource')) return;
    if (t.includes('chrome-extension://')) return;
    if (t.includes('401') || t.includes('403')) return;
    if (t.includes('net::ERR_')) return;
    consoleErrors.push(t);
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`PAGE_ERROR: ${err.message}`);
  });
});

test.describe('/login page', () => {
  test('renders form fields and Google button without console error', async ({ page }) => {
    const response = await page.goto(`${HUB_URL}/login`);
    expect(response?.status(), 'page /login should return 200').toBe(200);

    // Email field (LoginForm.tsx uses name="email" type="email")
    await expect(page.locator('input[name="email"]')).toBeVisible({ timeout: 10_000 });
    // Password field
    await expect(page.locator('input[name="password"]')).toBeVisible();
    // Submit button (the credentials form)
    await expect(page.locator('button[type="submit"]').first()).toBeVisible();
    // Google OAuth CTA — auth.config.ts ships Google as a provider, so the
    // LoginForm should always render this button when allowOauth is true.
    // We assert on the text rather than a class to be resilient to UI tweaks.
    await expect(
      page.getByRole('button', { name: /Continuer avec Google/i })
    ).toBeVisible();

    expect(
      consoleErrors,
      `Unexpected console errors on /login:\n${consoleErrors.join('\n')}`
    ).toHaveLength(0);
  });
});
