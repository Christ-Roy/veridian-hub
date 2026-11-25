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
  // ── Reste du moteur G2 arrêté ──
  // ── Repli codé, rien ne casse ──
  ANALYTICS_TRACK_URL: 'défaut : Rybbit prod (objectifs du Hub, lib/analytics/track-event.ts)',
  ANALYTICS_TRACK_URL_STAGING: 'staging seulement',
  ANALYTICS_TRACK_SITE_ID: 'défaut : site veridian.site (2) en prod, rien hors prod',
  AUTH_DEBUG: 'débogage local',
  CONNECTEURS_OUVERTS: 'absente = fermé, voulu : services extérieurs en attente de relecture et de Robert (25/11)',
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
  RECONCILE_ALERT_THRESHOLD: 'défaut 5',
  SMTP_HOST: 'repli si BREVO_API_KEY absente ; Brevo est rendu par le job',
  SMTP_PASSWORD: 'idem SMTP_HOST',
  SMTP_PORT: 'idem SMTP_HOST',
  SMTP_USER: 'idem SMTP_HOST',
  TRIAL_PERIOD_DAYS: 'défaut 7 (essai Stripe hérité)',
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
// Rendue aussi sous condition : `{{ with .X }}X={{ .Value }}{{ end }}`.
const rendues = new Set(Array.from(job.matchAll(/^\s*(?:\{\{ with [^}]+\}\})*([A-Z0-9_]+)\s*=/gm)).map((m) => m[1]));

/**
 * Noms construits à l'exécution (`env[\`HUB_INVITATION_SECRET_${app}\`]`) : le relevé ci-dessus ne les voit pas. 24/11 : perdu à la
 * bascule Nomad, celui de Notifuse rendait 503 à toute invitation, en silence. Chaque nom est rendu par le job, ou dit pourquoi non.
 */
const DYNAMIQUES: Record<string, string | null> = {
  HUB_INVITATION_SECRET_NOTIFUSE: null,
  HUB_INVITATION_SECRET_PROSPECTION: 'Prospection n\'appelle pas /api/invitations/create (24/11)',
  HUB_INVITATION_SECRET_ANALYTICS: 'Analytics n\'appelle pas /api/invitations/create (24/11)',
  HUB_INVITATION_SECRET_CMS: 'le CMS s\'éteint, hors de l\'identité du Hub',
  NOTIFUSE_HUB_API_SECRET: null,
  PROSPECTION_HUB_API_SECRET: null,
  ANALYTICS_HUB_API_SECRET: null,
  CRM_HUB_API_SECRET: null,
  ACADEMY_HUB_API_SECRET: null,
  CMS_HUB_API_SECRET: 'le CMS s\'éteint, hors de l\'identité du Hub',
};

describe('variables du job de prod', () => {
  it('toute variable dont le nom se construit à l\'exécution est rendue, ou absente avec sa raison', () => {
    const rendu = (v: string) => new RegExp(`(^|[\\s}])${v}=`, 'm').test(job.replace(/^\s*#.*$/gm, ''));
    expect(rendu('VARIABLE_INEXISTANTE')).toBe(false);
    for (const [v, raison] of Object.entries(DYNAMIQUES)) {
      if (raison === null) expect(rendu(v), `${v} absente de deploy/hub.nomad.hcl`).toBe(true);
      else expect(rendu(v), `${v} est rendue : retirer sa raison`).toBe(false);
    }
    const apps = Array.from(readFileSync('lib/invitations/hmac.ts', 'utf8').match(/SUPPORTED_APPS = \[([^\]]+)\]/)![1].matchAll(/'([a-z]+)'/g)).map((m) => m[1].toUpperCase());
    expect(apps.length).toBeGreaterThan(2);
    for (const a of apps) expect(Object.keys(DYNAMIQUES), a).toEqual(expect.arrayContaining([`HUB_INVITATION_SECRET_${a}`, `${a}_HUB_API_SECRET`]));
  });

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
