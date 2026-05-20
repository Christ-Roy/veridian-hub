/**
 * Journey 3 — Signup credentials complet → dashboard.
 *
 * Crée un user éphémère avec un email aléatoire, soumet le formulaire, vérifie
 * la redirection vers /dashboard. Le user reste en base staging (pas de cleanup
 * — la DB staging est régulièrement reset par le workflow).
 *
 * Si la regex DB staging change ou si /api/auth/signup régresse, ce test pète.
 */
import { test, expect } from '@playwright/test';

test.describe('Journey 3 — Signup credentials', () => {
  test('crée un user et atterrit sur /dashboard', async ({ page }) => {
    const stamp = Date.now();
    const email = `e2e-staging-${stamp}@e2e.veridian.site`;
    const password = 'StagingTest!2026';

    await page.goto('/signup');

    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('input[name="confirmPassword"]').fill(password);

    await page.getByRole('button', { name: /Créer mon compte/i }).click();

    // Attente du redirect vers dashboard OU MFA verify (selon config staging).
    // On accepte les deux : /dashboard direct OU /auth/mfa intermédiaire.
    await page.waitForURL((url) => url.pathname === '/dashboard' || url.pathname.startsWith('/auth/mfa') || url.pathname === '/login', { timeout: 20_000 });

    // En staging, MFA est probablement off pour le user fraichement créé.
    // Si on landed sur /login, c'est un signe que le signup n'a pas créé la session.
    expect(page.url()).not.toContain('/login');
  });
});
