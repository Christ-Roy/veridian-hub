/**
 * Login error UX — wrong password shows a visible error message.
 *
 * Vérifie que :
 *  - submit du formulaire avec un mauvais password ne crash pas
 *  - le message "Email ou mot de passe invalide." apparaît
 *  - on reste sur /login (pas de redirect dashboard)
 *  - 0 console error pendant le flow
 *
 * Cela couvre la branche `res?.error` de `LoginForm.tsx`. Si l'erreur
 * était silencieusement masquée (bug fréquent post-migration Auth.js v4
 * → v5 où le shape de res a changé), l'utilisateur penserait que le
 * submit a marché sans rien voir.
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
    // We DO want 401 in network → 401 here is the legit response from
    // /api/auth/callback/credentials with wrong password. Don't filter.
    if (t.includes('net::ERR_')) return;
    consoleErrors.push(t);
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`PAGE_ERROR: ${err.message}`);
  });
});

test.describe('/login wrong password UX', () => {
  test('submitting wrong credentials shows error and stays on /login', async ({ page }) => {
    await page.goto(`${HUB_URL}/login`);

    // The form must have rendered with the legacy email/password inputs.
    const emailInput = page.locator('input[name="email"]');
    const passwordInput = page.locator('input[name="password"]');
    await expect(emailInput).toBeVisible({ timeout: 10_000 });
    await expect(passwordInput).toBeVisible();

    // Submit known-bad credentials.
    await emailInput.fill(`nonexistent-${Date.now()}@yopmail.com`);
    await passwordInput.fill('definitely-wrong-password');
    await page.locator('button[type="submit"]').first().click();

    // The error message comes from LoginForm.tsx line 49:
    //   setError('Email ou mot de passe invalide.');
    // It's rendered in <p class="text-sm text-destructive">.
    const errorMsg = page.getByText('Email ou mot de passe invalide.');
    await expect(errorMsg).toBeVisible({ timeout: 10_000 });

    // We must still be on /login (Auth.js didn't redirect because the
    // signIn() rejected the credentials).
    expect(page.url(), 'must remain on /login after failed sign-in').toContain('/login');

    expect(
      consoleErrors,
      `Unexpected console errors during failed login:\n${consoleErrors.join('\n')}`
    ).toHaveLength(0);
  });
});
