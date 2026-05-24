import { defineConfig, devices } from '@playwright/test';

/**
 * Hub Playwright — config MEGA E2E (suite post-commercialisation).
 *
 * Cible : `https://hub.staging.veridian.site` (ou STAGING_URL override).
 * Couvre 24 buckets bout-en-bout (cf. `todo/2026-05-23-MEGA-E2E-*`).
 *
 * **DIFFÉRENCES vs `playwright.staging-full.config.ts`** :
 *   - testDir : `./e2e/staging-full/mega` (suite dédiée)
 *   - fullyParallel : true (isolation tenant garantit la safety, cf §4 ticket)
 *   - workers : 4 (CI) / 2 (local) — vs workers=1 staging-full
 *   - headless par défaut (HEADED=1 pour debug visuel) — vs headed par défaut staging-full
 *   - globalTeardown câblé sur `_global-teardown.ts` (cleanup Stripe + DBs)
 *   - timeout : 120s (certains flows trial → 15j prennent du temps)
 *   - reporter : ajoute html (debug post-run) + json (parser)
 *
 * **LANCÉ MANUELLEMENT** par l'agent via `pnpm e2e:mega` avant promo
 * prod tier 🔴 HAUT / 💀 CRITIQUE selon CI-ARCHITECTURE §20.6/20.7.
 *
 * **Plus tard câblé en CI** via workflow `hub-mega-e2e.yml` (Vague 3).
 *
 * Output :
 *   - `e2e-mega-staging.json` : rapport JSON parseable (formatter agent)
 *   - `playwright-report-mega/` : rapport HTML interactif (debug)
 *   - `test-results/` : screenshots / videos / traces
 */
export default defineConfig({
  testDir: './e2e/staging-full/mega',
  // Certains flows MEGA (trial state machine, stress 100 webhooks)
  // peuvent prendre plus de 90s. Budget large mais pas illimité.
  timeout: 120_000,
  expect: { timeout: 20_000 },

  // Isolation tenant stricte par scénario (cf. §4 ticket) → safe en parallèle.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // 1 retry en CI (flake possible sur webhook Stripe), 0 en local (on fix).
  retries: process.env.CI ? 1 : 0,
  // 4 workers en CI (machine GH Actions 4 vCPU), 2 en local (économise CPU).
  workers: process.env.CI ? 4 : 2,

  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e-mega-staging.json' }],
    ['html', { outputFolder: 'playwright-report-mega', open: 'never' }],
  ],

  // Cleanup final : Stripe customers test + DBs Hub/Notifuse/Prospection
  // + processus orphelins. Garanti même en cas de crash worker.
  globalTeardown: require.resolve('./e2e/staging-full/mega/_fixtures/_global-teardown'),

  use: {
    baseURL: process.env.STAGING_URL || 'https://hub.staging.veridian.site',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Headless par défaut (CI + runs rapides). HEADED=1 pour debug visuel.
    headless: process.env.HEADED !== '1',
    launchOptions: {
      slowMo: process.env.HEADED === '1' ? 100 : 0,
    },
  },

  projects: [
    {
      name: 'mega-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
