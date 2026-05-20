/**
 * Journey 2 — Les boutons OAuth amènent au consent screen du provider.
 *
 * On NE va PAS jusqu'au bout (pas d'auth automatique vers Google/Microsoft
 * sans compte test scripté), mais on valide que le clic déclenche bien la
 * redirection vers le provider. C'est le smoke crucial qui détecte qu'un
 * provider est mal configuré (secret manquant côté Auth.js → 500 immédiat
 * sans redirect).
 *
 * NB : si MICROSOFT_OAUTH_CLIENT_ID n'est pas configuré côté staging, le
 * test Microsoft devrait fail. C'est volontaire : la reco écrite agent
 * doit le signaler pour empêcher la promo prod.
 */
import { test, expect } from '@playwright/test';

test.describe('Journey 2 — OAuth providers redirect', () => {
  test('clic "Continuer avec Google" redirige vers accounts.google.com', async ({ page }) => {
    await page.goto('/login');
    const btn = page.getByRole('button', { name: /Continuer avec Google/i });
    await expect(btn).toBeVisible();

    // On attend la navigation déclenchée par signIn('google')
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('accounts.google.com') || r.url().includes('oauth2.googleapis.com'), { timeout: 20_000 }),
      btn.click(),
    ]);
    expect(response.status()).toBeLessThan(500);
    expect(response.url()).toContain('google');
  });

  test('clic "Continuer avec Microsoft" redirige vers login.microsoftonline.com', async ({ page }) => {
    await page.goto('/login');
    const btn = page.getByRole('button', { name: /Continuer avec Microsoft/i });
    await expect(btn).toBeVisible();

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('login.microsoftonline.com'), { timeout: 20_000 }),
      btn.click(),
    ]);
    expect(response.status()).toBeLessThan(500);
    expect(response.url()).toContain('microsoftonline.com');
  });
});
