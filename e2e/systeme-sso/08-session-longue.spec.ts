/**
 * Connexion automatique et session longue (CONTRAT-HUB §6bis.8.0) : la session vit au Hub, et le
 * rebond ouvre les apps sans saisie. Chaque cas prouve aussi l'inverse : sans session valable,
 * aucun accès. Comptes dédiés (C, D, E) : ces cas les déconnectent ou les suppriment.
 */
import { execFileSync } from 'node:child_process';

import { expect } from '@playwright/test';

import { APP_URL, HUB_URL, type AppKey } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { supprimerTenantHub } from './lib/hub-admin';
import { assurerRybbit, compte, contexteDe, ouvrirApp } from './lib/monde';
import { sessionApp } from './lib/parcours';

const APPS = ['prospection', 'notifuse', 'analytics'] as const;
const hote = (app: AppKey) => new URL(APP_URL[app]).host;

/** Lit AUTH_SECRET au moment du test pour forger un jeton expiré, jamais affiché. */
function secretAuth(): string {
  try {
    return execFileSync('nomad-v', ['raw', 'var', 'get', '-item', 'AUTH_SECRET', 'nomad/jobs/hub'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new NonAbouti('AUTH_SECRET illisible : à jouer depuis le bastion');
  }
}

for (const app of APPS) {
  cas(app, 'session Hub ouverte : l\'app s\'ouvre connectée sans saisie, sur la page demandée', async ({ browser }) => {
    const A = await compte(browser, 'A');
    if (app === 'analytics') assurerRybbit(A);
    const ctx = await contexteDe(browser, A);
    try {
      await ouvrirApp(ctx, app); // l'app a le compte après ce premier passage
      await ctx.clearCookies({ domain: hote(app) });
      const page = await ctx.newPage();
      await page.goto(APP_URL[app], { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8_000);
      const u = new URL(page.url());
      expect(u.host, `${app} : arrivée sur l'app, sans passer par un écran de connexion`).toBe(hote(app));
      expect(u.pathname, `${app} : pas sur sa page de connexion`).not.toMatch(/login|signin/);
      return `arrivée sur ${u.host}${u.pathname}`;
    } finally {
      await ctx.close();
    }
  });

  cas(app, 'sans session Hub : l\'écran de connexion, et aucun accès', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await page.goto(APP_URL[app], { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8_000);
      const u = new URL(page.url());
      const surHub = u.host === new URL(HUB_URL).host && u.pathname === '/login';
      const surAppLogin = u.host === hote(app) && /login|signin/.test(u.pathname);
      expect(surHub || surAppLogin, `${app} : écran de connexion attendu, vu ${u.host}${u.pathname}`).toBe(true);
      return `fin sur ${u.host}${u.pathname}`;
    } finally {
      await ctx.close();
    }
  });
}

cas(null, 'session à durée dépassée : le Hub ne la reconnaît plus', async ({ browser }) => {
  const A = await compte(browser, 'A');
  const { encode } = await import('next-auth/jwt');
  const nom = '__Secure-authjs.session-token';
  const forger = (maxAge: number) =>
    encode({ token: { uid: 'sans-objet', sub: 'sans-objet', email: A.email }, secret: secretAuth(), salt: nom, maxAge });
  const ctx = await browser.newContext();
  try {
    const hote = new URL(HUB_URL).hostname;
    await ctx.addCookies([{ name: nom, value: await forger(-3600), domain: hote, path: '/', secure: true, httpOnly: true }]);
    const lu = await (await ctx.request.get(`${HUB_URL}/api/auth/session`)).json();
    expect(lu?.user, 'jeton expiré depuis une heure : aucune session').toBeFalsy();
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    expect(new URL(page.url()).pathname, 'tableau de bord refusé').toBe('/login');
    return 'jeton expiré refusé, retour à la connexion';
  } finally {
    await ctx.close();
  }
});

cas(null, 'la session dure un an et se renouvelle à l\'usage', async ({ browser }) => {
  const A = await compte(browser, 'A');
  const ctx = await contexteDe(browser, A);
  try {
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    const c = (await ctx.cookies(HUB_URL)).find((x) => x.name.includes('session-token'));
    if (!c) throw new NonAbouti('cookie de session absent');
    const jours = (c.expires - Date.now() / 1000) / 86400;
    expect(jours, 'durée restante du cookie, en jours').toBeGreaterThan(300);
    return `cookie valable encore ${Math.round(jours)} jours`;
  } finally {
    await ctx.close();
  }
});

cas(null, 'aucun rebond automatique dans une iframe', async ({ browser }) => {
  const A = await compte(browser, 'A');
  const ctx = await contexteDe(browser, A);
  try {
    const page = await ctx.newPage();
    const liens: string[] = [];
    page.on('response', (r) => {
      if ((r.headers().location ?? '').match(/auth\/token|auto-login|magic-link/)) liens.push(r.url());
    });
    await page.goto(APP_URL.prospection, { waitUntil: 'domcontentloaded' });
    const next = encodeURIComponent(`${APP_URL.prospection}/`);
    await page.setContent(`<iframe src="${HUB_URL}/api/auth/bounce/prepare?next=${next}&auto=1"></iframe>`);
    await page.waitForTimeout(6_000);
    const avant = liens.length;
    const r = await ctx.request.fetch(`${HUB_URL}/api/auth/bounce/complete`, {
      headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' },
      maxRedirects: 0,
    });
    expect(r.status(), 'complete dans une iframe').toBe(204);
    expect(liens.length, 'lien émis depuis une iframe').toBe(avant);
    return 'iframe : 204, aucun lien émis';
  } finally {
    await ctx.close();
  }
});

cas(null, 'se déconnecter partout : le Hub et les apps coupent', async ({ browser }) => {
  const C = await compte(browser, 'C');
  assurerRybbit(C);
  const ctx = await contexteDe(browser, C);
  try {
    for (const app of APPS) await ouvrirApp(ctx, app);
    const avant = await Promise.all(APPS.map((a) => sessionApp(ctx, a)));
    if (avant.some((s) => !s)) throw new NonAbouti('pas de session d\'app avant la déconnexion, rien à prouver');
    const res = await ctx.request.post(`${HUB_URL}/api/account/sessions/revoke-all`);
    expect(res.status(), 'déconnexion partout').toBe(200);
    const hub = await (await ctx.request.get(`${HUB_URL}/api/auth/session`)).json();
    expect(hub?.user, 'session Hub coupée').toBeFalsy();
    const restes: string[] = [];
    for (const app of APPS) {
      if (await sessionApp(ctx, app)) restes.push(app);
    }
    expect(restes, 'apps où la session a survécu').toEqual([]);
    return 'Hub et 3 apps coupés';
  } finally {
    await ctx.close();
  }
}, { timeout: 240_000 });

cas(null, 'compte supprimé : plus aucun accès, avec sa session encore en main', async ({ browser }) => {
  const D = await compte(browser, 'D');
  assurerRybbit(D);
  const ctx = await contexteDe(browser, D);
  try {
    for (const app of APPS) await ouvrirApp(ctx, app);
    await supprimerTenantHub(D.email);
    const hub = await (await ctx.request.get(`${HUB_URL}/api/auth/session`)).json();
    expect(hub?.user, 'session Hub d\'un compte supprimé').toBeFalsy();
    const restes: string[] = [];
    for (const app of APPS) {
      if (await sessionApp(ctx, app)) restes.push(app);
    }
    expect(restes, 'apps encore ouvertes pour un compte supprimé').toEqual([]);
    return 'Hub et 3 apps coupés après suppression';
  } finally {
    await ctx.close();
  }
}, { timeout: 240_000 });
