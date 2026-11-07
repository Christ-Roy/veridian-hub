/**
 * Un compte à adresse prouvée arrive dans l'app, à son nom, et voit ses données.
 * Parcours réel : invitation → mot de passe → session Hub → « ouvrir l'app ».
 */
import { expect } from '@playwright/test';

import { devraitEtreArrive } from './lib/assertions';
import { APP_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { compte, contexteDe, noterArrivee, ouvrirApp , assurerRybbit } from './lib/monde';

const T = 'un compte à adresse prouvée arrive à son nom et voit ses données';

cas('prospection', T, async ({ browser }) => {
  const A = await compte(browser, 'A');
  const ctx = await contexteDe(browser, A);
  const a = await ouvrirApp(ctx, 'prospection');
  let ok = false;
  try {
    devraitEtreArrive(a, 'prospection');
    // à son nom : la session de l'app porte l'e-mail ET l'identifiant Hub du compte
    const s = await (await ctx.request.get(`${APP_URL.prospection}/api/auth/session`)).json();
    expect(s?.user?.email?.toLowerCase(), 'session Prospection : e-mail').toBe(A.email.toLowerCase());
    expect(s?.user?.id, 'session Prospection : identifiant = identifiant Hub').toBe(A.hubUserId);
    // ses données : son tenant et son espace de travail existent
    const me = await (await ctx.request.get(`${APP_URL.prospection}/api/me`)).json();
    expect(me?.tenantId, 'Prospection : tenant du compte').toBeTruthy();
    expect(me?.workspaces?.length, 'Prospection : au moins un espace de travail').toBeGreaterThan(0);
    const trial = await (await ctx.request.get(`${APP_URL.prospection}/api/trial`)).json();
    expect(trial?.plan, 'Prospection : plan lisible').toBeTruthy();
    ok = true;
    return `session ${A.email}, tenant ${me.tenantId}, plan ${trial.plan}`;
  } finally {
    noterArrivee('prospection', ok, a);
    await ctx.close();
  }
});

cas('notifuse', T, async ({ browser }) => {
  const A = await compte(browser, 'A');
  const ctx = await contexteDe(browser, A);
  const a = await ouvrirApp(ctx, 'notifuse');
  let ok = false;
  try {
    devraitEtreArrive(a, 'notifuse');
    expect(a.texte, 'Notifuse : la console annonce l\'e-mail du compte').toContain(A.email);
    const slug = A.email.replace(/^e2e-sso-/, '').split('@')[0];
    // ses données : son workspace (slug dérivé de l'identité) est dans le sélecteur
    expect(a.texte.replace(/[^a-z0-9]/gi, '').toLowerCase(), 'Notifuse : son workspace est listé').toContain(
      slug.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12),
    );
    ok = true;
    return `console ouverte pour ${A.email}`;
  } finally {
    noterArrivee('notifuse', ok, a);
    await ctx.close();
  }
});

cas('analytics', T, async ({ browser }) => {
  const A = await compte(browser, 'A');
  assurerRybbit(A);
  const ctx = await contexteDe(browser, A);
  const a = await ouvrirApp(ctx, 'analytics');
  let ok = false;
  try {
    devraitEtreArrive(a, 'analytics');
    // Rybbit : l'écran d'arrivée ne doit pas être une page de connexion
    expect(a.texte, 'Rybbit : pas de page de connexion').not.toMatch(/sign in|log in|connexion|se connecter/i);
    ok = true;
    return `arrivée sur ${a.chemin}`;
  } finally {
    noterArrivee('analytics', ok, a);
    await ctx.close();
  }
});

cas('twenty', T, async () => {
  const r = await fetch(`${APP_URL.twenty}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r || r.status >= 400) {
    throw new NonAbouti(
      `Twenty staging non servi (${APP_URL.twenty}/healthz → ${r ? 'HTTP ' + r.status : 'injoignable'}) : cas non joué`,
    );
  }
  throw new NonAbouti('Twenty servi, mais le parcours Twenty n\'est pas encore écrit dans la batterie');
});
