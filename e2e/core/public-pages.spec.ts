/**
 * Public pages smoke — /signup et /pricing rendent sans erreur.
 *
 * Ces 2 pages sont accessibles sans auth (cf authConfig.authorized) et
 * sont des points d'entrée pour les nouveaux users :
 *  - /signup : où l'on crée son compte
 *  - /pricing : où l'on choisit son plan + clique Stripe Checkout
 *
 * Si l'une crash (500 server-side ou JS error client-side), le funnel
 * d'acquisition est cassé. Ce spec est le filet de sécurité minimum.
 *
 * On ne teste pas le flux Stripe Checkout complet ici (nécessite un
 * user signé) — c'est l'objet d'un autre spec à venir.
 */
import { test, expect, type ConsoleMessage } from '@playwright/test';

const HUB_URL = process.env.HUB_URL || 'http://localhost:3000';

let consoleErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
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

test.describe('Public pages render', () => {
  test('/signup renders email + password inputs', async ({ page }) => {
    const response = await page.goto(`${HUB_URL}/signup`);
    expect(response?.status(), '/signup must return 200').toBe(200);

    // Same SignupForm shape as LoginForm: email + password + submit.
    await expect(page.locator('input[name="email"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]').first()).toBeVisible();

    expect(
      consoleErrors,
      `Unexpected console errors on /signup:\n${consoleErrors.join('\n')}`
    ).toHaveLength(0);
  });

  test('/pricing renders plan cards without 5xx', async ({ page }) => {
    const response = await page.goto(`${HUB_URL}/pricing`);
    expect(response?.status(), '/pricing must return 200').toBe(200);

    // The Pricing component shows at least one price card. Rather than
    // hard-code a plan name (which can change), we assert that the body
    // has substantial text — i.e. the SSR didn't fail to render the
    // products from Prisma.
    const bodyText = await page.locator('body').innerText();
    expect(
      bodyText.length,
      '/pricing body should not be near-empty (Prisma fetch may have failed)'
    ).toBeGreaterThan(200);

    expect(
      consoleErrors,
      `Unexpected console errors on /pricing:\n${consoleErrors.join('\n')}`
    ).toHaveLength(0);
  });
});
