/**
 * Batterie système SSO : le Hub est-il la source unique des utilisateurs de nos apps ?
 * Prod par défaut, un seul worker (rythme modéré, comptes de test partagés), aucun retry
 * (un cas instable est un résultat, pas un accident). Lancement : `pnpm test:systeme`.
 */
import { randomBytes } from 'node:crypto';

import { defineConfig } from '@playwright/test';

process.env.SSO_RUN_ID ||= `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

/** Essais tenus des heures (48, 49) et recette de A à Z (50) : jamais dans la batterie complète, seulement nommés (`… 50-`). 26/11 : 49 tenait 2 h la prod. */
const NOMMES_SEULEMENT = /^(48|49|50)-/;
export const demandeNommee = (argv: string[]) => argv.some((a) => NOMMES_SEULEMENT.test(a.split('/').pop() ?? ''));

export default defineConfig({
  testDir: '.',
  testMatch: /\d\d-.*\.spec\.ts$/,
  testIgnore: demandeNommee(process.argv.slice(2)) ? [] : [/(^|\/)(48|49|50)-.*\.spec\.ts$/],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 10_000 },
  reporter: [['./reporter.ts']],
  globalTeardown: './global-teardown.ts',
  use: {
    // PW_WS : navigateur distant (`scripts/navigateur-distant.sh`). Absent, Chromium local comme avant.
    ...(process.env.PW_WS
      ? { connectOptions: { wsEndpoint: process.env.PW_WS, timeout: 30_000 } }
      : { launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {} }),
    locale: 'fr-FR',
    userAgent: 'Veridian-Systeme-SSO/1.0 (test systeme libelle)',
  },
});
