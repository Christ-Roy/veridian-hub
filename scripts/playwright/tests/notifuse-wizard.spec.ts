import { test, expect } from '@playwright/test';

/**
 * Test automatisé pour compléter le wizard de setup Notifuse
 *
 * Ce test:
 * 1. Navigue vers la page de setup du workspace Notifuse
 * 2. Clique sur le bouton "Complete Setup"
 * 3. Vérifie que le setup est terminé (redirection vers la console)
 */

test.describe('Notifuse Setup Wizard', () => {
  test('completes the initial setup', async ({ page }) => {
    // URL du workspace Notifuse (peut être configurée via env var)
    const workspaceUrl = process.env.NOTIFUSE_SETUP_URL || 'https://notifuse.dev.veridian.site/console/setup';

    console.log(`🔧 Navigating to Notifuse setup: ${workspaceUrl}`);

    // Naviguer vers la page de setup
    await page.goto(workspaceUrl);

    // Attendre que la page soit chargée
    await page.waitForLoadState('networkidle');

    // Vérifier qu'on est sur la page de setup
    await expect(page).toHaveURL(/\/console\/setup/);

    console.log('✅ Setup page loaded');

    // Cliquer sur le bouton "Complete Setup"
    // Le sélecteur utilise le rôle "button" et le texte "check Complete Setup"
    const completeButton = page.getByRole('button', { name: 'check Complete Setup' });

    await expect(completeButton).toBeVisible();
    await completeButton.click();

    console.log('✅ Clicked "Complete Setup" button');

    // Attendre la redirection après le setup
    await page.waitForURL(/\/console\//, { timeout: 10000 });

    // Vérifier qu'on a été redirigé vers la console
    expect(page.url()).toMatch(/\/console\//);

    console.log('✅ Setup completed, redirected to console');
  });
});
