import { defineConfig, devices } from '@playwright/test';

/**
 * Hub Playwright — config "juge de paix tunnel" (gates G0→G10 de parité bridge↔Hub).
 *
 * Cible : `https://hub.staging.veridian.site` (ou STAGING_URL override).
 * Lancé via `pnpm e2e:tunnel` (launcher `scripts/e2e/tunnel-gates.sh` qui source
 * les secrets HMAC/Bearer/CRON_SECRET du container hub-staging, comme staging-full).
 *
 * Spécificités :
 *   - testDir: e2e/tunnel (les gates portés du bridge tunnel-de-vente)
 *   - workers: 1, fullyParallel: false (flow strictement sériel : G0→G10)
 *   - retries: 0 (un gate rouge = on investigue la parité, pas on re-roule)
 *   - headless toujours (pilotage HTTP pur, pas d'UI)
 *
 * Output : `e2e-tunnel-gates.json` à la racine (réutilisable par un formatter CI).
 */
export default defineConfig({
  testDir: './e2e/tunnel',
  timeout: 120_000, // marge pour les ticks de cron (N prospects × push séquentiel)
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e-tunnel-gates.json' }],
  ],
  use: {
    baseURL: process.env.STAGING_URL || 'https://hub.staging.veridian.site',
    trace: 'retain-on-failure',
    // Pilotage HTTP pur (request fixture) — pas de navigateur visuel nécessaire.
    headless: true,
  },
  projects: [
    {
      name: 'tunnel-gates',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
