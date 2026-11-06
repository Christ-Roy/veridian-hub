/**
 * Batterie système SSO : le Hub est-il la source unique des utilisateurs de nos apps ?
 * Prod par défaut, un seul worker (rythme modéré, comptes de test partagés), aucun retry
 * (un cas instable est un résultat, pas un accident). Lancement : `pnpm test:systeme`.
 */
import { randomBytes } from 'node:crypto';

import { defineConfig } from '@playwright/test';

process.env.SSO_RUN_ID ||= `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

export default defineConfig({
  testDir: '.',
  testMatch: /\d\d-.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 10_000 },
  reporter: [['./reporter.ts']],
  globalTeardown: './global-teardown.ts',
  use: {
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
    locale: 'fr-FR',
    userAgent: 'Veridian-Systeme-SSO/1.0 (test systeme libelle)',
  },
});
