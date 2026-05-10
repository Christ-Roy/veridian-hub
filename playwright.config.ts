import { defineConfig, devices } from '@playwright/test';

/**
 * Hub Playwright config — minimal et focalisé sur le SPOF Auth.js.
 *
 * Stratégie:
 *  - core/  → specs bloquants (smoke health, Auth.js endpoints, login render).
 *  - prod-smoke/ → specs read-only contre la PROD post-deploy (rollback gate).
 *
 * On lance chromium uniquement par défaut. Les fails cross-browser sur le
 * hub sont rarissimes (pas d'UI métier complexe) et le coût CI ne vaut pas
 * la matrix 3 browsers.
 *
 * Pas de webServer auto: en CI on hit le staging/prod déjà déployé. En
 * local, l'utilisateur doit `pnpm build && pnpm start` avant de lancer
 * les tests (ou exporter HUB_URL).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? 'list' : 'list',
  use: {
    baseURL: process.env.HUB_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Hub a un setup TLS standard derrière Traefik, pas besoin de bypass.
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
