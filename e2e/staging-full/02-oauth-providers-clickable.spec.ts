/**
 * Journey 2 — Vérification de l'invariant "OAuth désactivé en staging".
 *
 * Décision Robert 2026-05-20 : `hub.staging.veridian.site` est derrière
 * Tailscale (IP privée), donc on N'AFFICHE PAS les boutons OAuth Google/
 * Microsoft pour éviter de déclarer des redirect URIs privées chez les
 * providers (red flag réputation). Cf. memory
 * `feedback_oauth_pas_sur_staging_tailscale.md`.
 *
 * Ce test verrouille cette invariant : si quelqu'un ré-active OAuth en
 * staging par erreur (genre en remettant `allowOauth = true` en dur dans
 * settings.ts), le test fail et empêche la régression.
 *
 * Pour tester OAuth de bout en bout, utiliser :
 *   - local-dev (Client OAuth avec redirect localhost:3000)
 *   - ou directement en prod via protocole §20.6
 */
import { test, expect } from '@playwright/test';

test.describe('Journey 2 — Invariant OAuth désactivé en staging', () => {
  test('GET /login : pas de bouton "Continuer avec Google"', async ({ page }) => {
    await page.goto('/login');
    const btn = page.getByRole('button', { name: /Continuer avec Google/i });
    await expect(btn).toHaveCount(0);
  });

  test('GET /login : pas de bouton "Continuer avec Microsoft"', async ({ page }) => {
    await page.goto('/login');
    const btn = page.getByRole('button', { name: /Continuer avec Microsoft/i });
    await expect(btn).toHaveCount(0);
  });

  test('GET /signup : pas de bouton "Continuer avec Google"', async ({ page }) => {
    await page.goto('/signup');
    const btn = page.getByRole('button', { name: /Continuer avec Google/i });
    await expect(btn).toHaveCount(0);
  });

  test('GET /signup : pas de bouton "Continuer avec Microsoft"', async ({ page }) => {
    await page.goto('/signup');
    const btn = page.getByRole('button', { name: /Continuer avec Microsoft/i });
    await expect(btn).toHaveCount(0);
  });

  test('Credentials login form reste affiché (fallback principal en staging)', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Se connecter/i })).toBeVisible();
  });
});
