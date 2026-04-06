import { defineConfig, devices } from '@playwright/test';

/**
 * Configuration Playwright pour automatiser le wizard Notifuse
 *
 * Usage:
 *   npm run test:notifuse       # Exécute en mode headless
 *   npm run test:notifuse:ui    # Exécute avec UI Playwright
 *   npm run test:notifuse:debug # Exécute en mode debug (headed)
 */

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // Un test à la fois pour Notifuse
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 30000, // 30s max par test
  use: {
    // Base URL et options
    baseURL: process.env.NOTIFUSE_BASE_URL || 'https://notifuse.dev.veridian.site',
    ignoreHTTPSErrors: true, // Ignorer les erreurs SSL en dev

    // Options de trace (pour debug)
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    // Mode headless par défaut
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],

  // Pas de webServer - on teste contre l'URL existante
});
