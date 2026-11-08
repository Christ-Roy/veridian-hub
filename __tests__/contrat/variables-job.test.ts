/**
 * Contrat : chaque variable d'environnement que lit le code du Hub est rendue par le job de prod
 * (`deploy/hub.nomad.hcl`, celui que pose la CI), ou figure ci-dessous comme FACULTATIVE avec sa
 * raison. 08/11 : `MICROSOFT_OAUTH_CLIENT_ID` manquait au job, le Hub envoyait `client_id=undefined`
 * et la connexion Microsoft de Robert échouait ; Telegram manquait aussi, en silence.
 *
 * Ajouter une variable au code sans l'ajouter au job (ou ici, avec sa raison) fait échouer ce test.
 * La liste FACULTATIVES est aussi la liste de « ce qui manque » : la vider, c'est câbler.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { code, parcourir } from './source';

/** Lues par le code, volontairement absentes du job de prod : chacune dit pourquoi. */
const FACULTATIVES: Record<string, string> = {
  // ── Manque réel, à câbler (08/11) ──
  TELEGRAM_BOT_TOKEN: 'MANQUE : alertes Telegram du Hub (Stripe, essai) jamais envoyées en prod ; chat id inconnu des credentials',
  TELEGRAM_CHAT_ID: 'MANQUE : idem, à fournir avec le jeton',
  ANALYTICS_TRACK_URL: 'MANQUE : suivi des objectifs (inscription) du Hub vers Analytics non envoyé en prod',
  ANALYTICS_ADMIN_KEY: 'MANQUE : client admin Analytics du Hub non configuré en prod',
  // ── Repli codé, rien ne casse ──
  ANALYTICS_TRACK_URL_STAGING: 'staging seulement',
  AUTH_DEBUG: 'débogage local',
  DASHBOARD_GTM_ID: 'repli NEXT_PUBLIC_GTM_ID',
  DASHBOARD_NOTIFUSE_API_URL: 'repli NEXT_PUBLIC_NOTIFUSE_API_URL',
  DASHBOARD_NOTIFUSE_URL: 'repli NEXT_PUBLIC_NOTIFUSE_URL',
  DASHBOARD_STRIPE_PUBLISHABLE_KEY: 'repli NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  DASHBOARD_STRIPE_PUBLISHABLE_KEY_LIVE: 'repli NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE',
  E2E_RATELIMIT_BYPASS_SECRET: 'tests e2e hors prod',
  HUB_GIT_SHA: 'injecté à la construction de l\'image',
  MAIL_RATE_LIMIT_BYPASS_SECRET: 'tests hors prod',
  NEXT_PUBLIC_APP_URL: 'repli https://app.veridian.site (mails d\'essai)',
  NEXT_PUBLIC_DOMAIN: 'repli DOMAIN',
  NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID: 'repli GOOGLE_OAUTH_CLIENT_ID (app/layout.tsx)',
  NEXT_PUBLIC_VERCEL_URL: 'héritage Vercel, inutilisé',
  PROSPECTION_HUB_API_SECRET: 'repli PROSPECTION_TENANT_API_SECRET, rendu par le job',
  RECONCILE_ALERT_THRESHOLD: 'défaut 5',
  SMTP_HOST: 'repli si BREVO_API_KEY absente ; Brevo est rendu par le job',
  SMTP_PASSWORD: 'idem SMTP_HOST',
  SMTP_PORT: 'idem SMTP_HOST',
  SMTP_USER: 'idem SMTP_HOST',
  STRIPE_REFILL_PRODUCT_ID_TEST: 'mode test Stripe hors prod',
  TRIAL_PERIOD_DAYS: 'défaut 7 (essai Stripe hérité)',
  TRIAL_MACHINE_ENABLED: 'drapeau : flow d\'essai réel coupé tant que Robert n\'a pas dit oui',
};

const lues = new Set<string>();
const SOURCES = [
  ...['app', 'lib', 'utils', 'components', 'contexts'].flatMap(parcourir),
  'auth.ts',
  'auth.config.ts',
  'middleware.ts',
].filter((p) => /\.(ts|tsx)$/.test(p));
for (const f of SOURCES) {
  for (const m of code(f).matchAll(/process\.env\.([A-Z0-9_]+)|process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) {
    lues.add(m[1] ?? m[2]);
  }
}
const job = readFileSync('deploy/hub.nomad.hcl', 'utf8');
const rendues = new Set(Array.from(job.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)).map((m) => m[1]));

describe('variables du job de prod', () => {
  it('outil : le relevé voit les variables du code et du job', () => {
    expect(lues.has('MICROSOFT_OAUTH_CLIENT_ID')).toBe(true);
    expect(rendues.has('GOOGLE_OAUTH_CLIENT_ID')).toBe(true);
  });

  it('les fournisseurs OAuth de auth.config.ts ont leurs deux variables dans le job', () => {
    const oauth = Array.from(code('auth.config.ts').matchAll(/process\.env\.([A-Z0-9_]*OAUTH[A-Z0-9_]*)/g)).map((m) => m[1]);
    expect(oauth.length).toBeGreaterThan(0);
    for (const v of oauth) expect(rendues.has(v), `${v} absente de deploy/hub.nomad.hcl`).toBe(true);
  });

  it('toute variable lue est rendue par le job, ou facultative avec sa raison', () => {
    const manquantes = Array.from(lues).filter((v) => !rendues.has(v) && !(v in FACULTATIVES) && v !== 'NODE_ENV');
    expect(manquantes, 'à rendre dans deploy/hub.nomad.hcl, ou à déclarer FACULTATIVE avec sa raison').toEqual([]);
  });

  it('une facultative devenue rendue sort de la liste (la liste reste juste)', () => {
    const perimees = Object.keys(FACULTATIVES).filter((v) => rendues.has(v));
    expect(perimees).toEqual([]);
  });
});
