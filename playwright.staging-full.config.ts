import { defineConfig, devices } from '@playwright/test';

/**
 * Hub Playwright — config "staging full fidelity".
 *
 * Cible : `https://hub.staging.veridian.site` (ou STAGING_URL override).
 * Lancé manuellement par l'agent via `pnpm e2e:staging:full` avant d'écrire
 * une reco de promotion prod selon le protocole CI-ARCHITECTURE §20.6/20.7.
 *
 * Pas exécuté en CI :
 *   - Trop long (8-15 min) pour bloquer chaque push staging
 *   - Headfull + slowMo pour fidélité visuelle, pas headless rapide
 *   - Utilise de vrais comptes test (Google, Microsoft) → flaky en CI sandbox
 *
 * Différences clé vs `playwright.config.ts` :
 *   - testDir: e2e/staging-full (specs lourds dédiés)
 *   - headed: true par défaut (peut être overridé par HEADED=0)
 *   - slowMo: 150ms pour visibilité
 *   - reporter: JSON pour parsing par format-staging-report.js
 *   - workers: 1 (pas de parallel — on veut un flow sériel propre)
 *   - retries: 1 (1 seul retry au lieu de 2 — flake = on investigue)
 *
 * Output : `e2e-headfull-staging.json` à la racine. Lu ensuite par le
 * formatter qui produit la reco écrite agent.
 */
export default defineConfig({
  testDir: './e2e/staging-full',
  timeout: 90_000, // les flows OAuth peuvent prendre du temps (consent screens)
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  // Filet de sécurité anti-fuite chromium : tue les processus orphelins
  // laissés par les specs qui font `playwright.chromium.launch()` à la
  // main et qui crashent avant `browser.close()`. Cf. ticket
  // `todo/2026-05-23-e2e-cleanup-browser-resources.md`.
  globalTeardown: require.resolve('./e2e/staging-full/_global-teardown.ts'),
  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e-headfull-staging.json' }],
  ],
  use: {
    baseURL: process.env.STAGING_URL || 'https://hub.staging.veridian.site',
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'retain-on-failure',
    headless: process.env.HEADED === '0',
    launchOptions: {
      slowMo: process.env.HEADED === '0' ? 0 : 150,
    },
  },
  projects: [
    {
      name: 'chromium-staging-full',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
