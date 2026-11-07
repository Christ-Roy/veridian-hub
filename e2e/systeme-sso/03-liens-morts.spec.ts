/**
 * Un lien déjà consommé, inconnu ou expiré n'ouvre aucune session.
 * Chaque cas rejoue d'abord le lien NEUF (témoin positif : il ouvre bien une session), puis
 * le même lien dans un navigateur vierge. Le contrôle d'échec en ligne prouve que
 * l'assertion tomberait si le lien rouvrait la session.
 */
import { randomBytes } from 'node:crypto';

import { expect } from '@playwright/test';

import { devraitEtreSansSession } from './lib/assertions';
import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { impersonate } from './lib/hub-admin';
import { compte, contexteDe, ouvrirApp } from './lib/monde';
import { ouvrirLien } from './lib/parcours';

const hex = () => randomBytes(32).toString('hex');

cas(null, 'hub · un lien consommé n\'ouvre plus de session', async ({ browser }) => {
  const A = await compte(browser, 'A');
  const lien = (await impersonate(A.email)).links.hub;
  const neuf = await ouvrirLien(browser, lien, 'hub');
  expect(neuf.session?.email?.toLowerCase(), 'témoin : le lien neuf ouvre la session Hub').toBe(A.email.toLowerCase());
  expect(() => devraitEtreSansSession(neuf, A.email), 'contrôle : l\'assertion tombe sur un lien vivant').toThrow();
  const rejoue = await ouvrirLien(browser, lien, 'hub');
  devraitEtreSansSession(rejoue, A.email);
});

cas('prospection', 'un lien consommé n\'ouvre plus de session', async ({ browser }) => {
  const A = await compte(browser, 'A');
  const lien = (await impersonate(A.email)).links.prospection;
  if (!lien) throw new NonAbouti('le Hub n\'a pas émis de lien Prospection pour le compte de test');
  const neuf = await ouvrirLien(browser, lien, 'prospection');
  expect(neuf.session?.email?.toLowerCase(), 'témoin : le lien neuf ouvre la session Prospection').toBe(A.email.toLowerCase());
  expect(() => devraitEtreSansSession(neuf, A.email), 'contrôle : l\'assertion tombe sur un lien vivant').toThrow();
  const rejoue = await ouvrirLien(browser, lien, 'prospection');
  devraitEtreSansSession(rejoue, A.email);
});

cas('notifuse', 'un lien consommé n\'ouvre plus de session', async ({ browser }) => {
  const A = await compte(browser, 'A');
  const ctx = await contexteDe(browser, A);
  const a = await ouvrirApp(ctx, 'notifuse'); // consomme le lien émis par le rebond
  await ctx.close();
  if (!a.lienUnique) throw new NonAbouti('aucun lien à usage unique observé dans le rebond Notifuse');
  expect(a.texte, 'témoin : le lien neuf a ouvert la console').toContain(A.email);
  const rejoue = await ouvrirLien(browser, a.lienUnique, 'notifuse');
  devraitEtreSansSession(rejoue, A.email);
});

for (const [app, fabrique] of [
  ['prospection', () => `${APP_URL.prospection}/api/auth/token?t=${hex()}`],
  ['notifuse', () => `${APP_URL.notifuse}/veridian/auto-login?token=${hex()}`],
] as const) {
  cas(app, 'un lien inconnu n\'ouvre aucune session', async ({ browser }) => {
    const A = await compte(browser, 'A');
    const vue = await ouvrirLien(browser, fabrique(), app);
    devraitEtreSansSession(vue, A.email);
  });
}

cas(null, 'hub · un lien d\'impersonation inconnu n\'ouvre aucune session', async ({ browser }) => {
  const A = await compte(browser, 'A');
  const vue = await ouvrirLien(browser, `${HUB_URL}/api/auth/impersonate-callback?token=${hex()}`, 'hub');
  devraitEtreSansSession(vue, A.email);
});

/**
 * Expiration réelle : attend le TTL du lien (10 min côté Hub). Coûteux en durée, donc
 * joué par défaut (aucune charge : une attente). SSO_EXPIRY=0 l'ignore, et le cas est alors NON ABOUTI, jamais vert.
 */
cas(null, 'hub · un lien expiré n\'ouvre aucune session (attend le TTL)', async ({ browser }) => {
  if (process.env.SSO_EXPIRY === '0') throw new NonAbouti('expiration non rejouée (SSO_EXPIRY=0)');
  const A = await compte(browser, 'A');
  const lien = (await impersonate(A.email)).links.hub;
  await new Promise((r) => setTimeout(r, 10 * 60_000 + 20_000));
  const vue = await ouvrirLien(browser, lien, 'hub');
  devraitEtreSansSession(vue, A.email);
}, { timeout: 15 * 60_000 });
