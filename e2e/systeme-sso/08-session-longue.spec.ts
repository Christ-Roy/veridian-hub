/**
 * Connexion automatique et session longue (CONTRAT-HUB §6bis.8.0) : la session vit au Hub, et le
 * rebond ouvre les apps sans saisie. Cinq scénarios par app : session ouverte, absente, expirée,
 * déconnexion partout, compte supprimé. Chaque absence se prouve à côté de sa présence.
 *
 * `SSO_SABOTAGE=<scenario>` retire le geste que le scénario prouve : il DOIT alors échouer. C'est
 * l'épreuve de la batterie elle-même, à rejouer quand ce fichier change (README).
 */
import { execFileSync } from 'node:child_process';

import { expect, type Browser, type BrowserContext, type Cookie } from '@playwright/test';

import { APP_URL, HUB_URL, type AppKey } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { supprimerTenantHub } from './lib/hub-admin';
import { assurerRybbit, compte, contexteDe, ouvrirApp } from './lib/monde';
import { PAGE_PROTEGEE, voirApp, type Compte } from './lib/parcours';

const SUR_STAGING = /staging/.test(HUB_URL);
// Twenty n'existe qu'en staging : il se joue contre le Hub staging, les autres contre le Hub prod.
const APPS: readonly AppKey[] = SUR_STAGING ? ['twenty'] : ['prospection', 'notifuse', 'analytics'];
const sabote = (s: string) => process.env.SSO_SABOTAGE === s;
const hoteHub = new URL(HUB_URL).hostname;
const NOM_COOKIE = HUB_URL.startsWith('https') ? '__Secure-authjs.session-token' : 'authjs.session-token';

const prevoirCompte = (c: Compte, app: AppKey) => {
  if (app === 'analytics') assurerRybbit(c);
};

function cookieHub(cookies: Cookie[]): string {
  const c = cookies.find((x) => x.name === NOM_COOKIE);
  if (!c) throw new NonAbouti('cookie de session Hub absent, rien à prouver');
  return c.value;
}

/** Un navigateur neuf qui ne possède que ce cookie de session : celui qui l'aurait volé. */
async function navigateurAvec(browser: Browser, valeur: string) {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: NOM_COOKIE, value: valeur, domain: hoteHub, path: '/', secure: true, httpOnly: true }]);
  return ctx;
}

async function sessionHub(ctx: BrowserContext) {
  const r = await ctx.request.get(`${HUB_URL}/api/auth/session`);
  return ((await r.json().catch(() => null)) as { user?: { email?: string } } | null)?.user ?? null;
}

/** Le Hub lu comme par un vrai visiteur : le middleware passe d'abord et réécrit le cookie. */
async function dashboardOuvert(ctx: BrowserContext) {
  const page = await ctx.newPage();
  await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  const ouvert = new URL(page.url()).pathname.startsWith('/dashboard');
  await page.close();
  return ouvert;
}

/**
 * Lu dans Nomad au moment du test, jamais affiché : c'est la valeur que le Hub utilise vraiment. La
 * copie de `.all-creds.env` a déjà divergé (mesuré le 07/11), elle ne fait pas foi.
 */
function secretAuth(): string {
  if (process.env.SSO_AUTH_SECRET) return process.env.SSO_AUTH_SECRET;
  const job = SUR_STAGING ? 'hub-staging' : 'hub';
  try {
    const v = execFileSync('nomad-v', ['raw', 'var', 'get', '-item', SUR_STAGING ? 'AUTH_SECRET' : 'HUB_AUTH_SECRET', `nomad/jobs/${job}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (v) return v;
  } catch {
    /* traité ci-dessous */
  }
  throw new NonAbouti('HUB_AUTH_SECRET illisible dans Nomad : à jouer depuis le bastion, ou SSO_AUTH_SECRET');
}

/** Réécrit ce jeton réel avec une autre durée : même compte, seule l'échéance change. */
async function rejeter(valeur: string, maxAge: number): Promise<string> {
  const { decode, encode } = await import('next-auth/jwt');
  const secret = secretAuth();
  const token = await decode({ token: valeur, secret, salt: NOM_COOKIE }).catch(() => null);
  if (!token?.uid) throw new NonAbouti('jeton de session illisible avec AUTH_SECRET');
  return encode({ token, secret, salt: NOM_COOKIE, maxAge });
}

for (const app of APPS) {
  cas(app, 'session Hub ouverte : arrivée connectée sur la page demandée, sans saisie', async ({ browser }) => {
    const A = await compte(browser, 'A');
    prevoirCompte(A, app);
    // Contexte neuf : aucune session d'app (cookie ni localStorage), seul le Hub peut ouvrir la porte.
    const ctx = sabote('ouverte') ? await browser.newContext() : await contexteDe(browser, A);
    try {
      const v = await voirApp(ctx, app);
      expect(v.connecte, `${app} : connecté, vu ${v.hote}${v.chemin}`).toBe(true);
      expect(v.chemin.replace(/\/$/, ''), `${app} : page demandée`).toContain(PAGE_PROTEGEE[app].replace(/\/$/, ''));
      expect(v.rebondsAuto, `${app} : un seul rebond automatique`).toBeLessThanOrEqual(1);
      return `arrivée sur ${v.hote}${v.chemin}, ${v.rebondsAuto} rebond`;
    } finally {
      await ctx.close();
    }
  }, { timeout: 180_000 });

  cas(app, 'sans session Hub : écran de connexion, puis retour à la page demandée', async ({ browser }) => {
    const A = await compte(browser, 'A');
    prevoirCompte(A, app);
    const ctx = sabote('absente') ? await contexteDe(browser, A) : await browser.newContext();
    const autres: BrowserContext[] = [];
    try {
      const v = await voirApp(ctx, app);
      expect(v.connecte, `${app} : aucun accès sans session, vu ${v.hote}${v.chemin}`).toBe(false);
      expect(v.rebondsAuto, `${app} : pas de rafale de rebonds`).toBeLessThanOrEqual(1);
      if (v.hote !== hoteHub) return `sans session : ${v.hote}${v.chemin} (écran de l'app)`;
      // Le parcours continue dans un navigateur neuf : ici l'app a déjà posé son cookie d'essai unique.
      const neuf = await browser.newContext();
      autres.push(neuf);
      const page = await neuf.newPage();
      await page.goto(`${APP_URL[app]}${PAGE_PROTEGEE[app]}`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL((u) => u.hostname === hoteHub, { timeout: 30_000 });
      await page.locator('input[type=email], input[name=email]').first().fill(A.email);
      await page.locator('input[type=password]').first().fill(A.motDePasse);
      await page.getByRole('button', { name: /^(Se connecter|Continuer)/i }).first().click();
      await page.waitForURL((u) => u.host === new URL(APP_URL[app]).host, { timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      const u = new URL(page.url());
      expect(u.pathname.replace(/\/$/, ''), `${app} : retour à la page demandée`).toContain(
        PAGE_PROTEGEE[app].replace(/\/$/, ''),
      );
      return `connexion au Hub puis ${u.host}${u.pathname}`;
    } finally {
      await Promise.all(autres.map((c) => c.close()));
      await ctx.close();
    }
  }, { timeout: 240_000 });

  cas(app, 'session Hub expirée : plus aucun accès, le même jeton non expiré ouvre', async ({ browser }) => {
    const A = await compte(browser, 'A');
    prevoirCompte(A, app);
    const source = await contexteDe(browser, A);
    const valeur = cookieHub(await source.cookies(HUB_URL));
    await source.close();
    // Présence : le jeton réécrit avec une échéance future ouvre l'app. Sinon la réécriture est fausse.
    const valable = await navigateurAvec(browser, await rejeter(valeur, 3600));
    try {
      const v = await voirApp(valable, app);
      if (!v.connecte) throw new NonAbouti(`le témoin n'ouvre pas ${app} (${v.hote}${v.chemin}) : rien à conclure`);
    } finally {
      await valable.close();
    }
    const expire = await navigateurAvec(browser, await rejeter(valeur, sabote('expiree') ? 3600 : -3600));
    try {
      expect(await sessionHub(expire), 'Hub : jeton expiré depuis une heure').toBeFalsy();
      const v = await voirApp(expire, app);
      expect(v.connecte, `${app} : jeton expiré, vu ${v.hote}${v.chemin}`).toBe(false);
      return `expiré refusé, témoin non expiré accepté, fin sur ${v.hote}${v.chemin}`;
    } finally {
      await expire.close();
    }
  }, { timeout: 240_000 });
}

cas(null, 'la session dure un an et se renouvelle à l\'usage', async ({ browser }) => {
  const A = await compte(browser, 'A');
  const ctx = await contexteDe(browser, A);
  try {
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    const c = (await ctx.cookies(HUB_URL)).find((x) => x.name === NOM_COOKIE);
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
    const r = await ctx.request.get(`${HUB_URL}/api/auth/bounce/complete`, {
      headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' },
      maxRedirects: 0,
    });
    expect(r.status(), 'complete dans une iframe').toBe(204);
    const login = await ctx.request.get(`${HUB_URL}/login`, { maxRedirects: 0 });
    expect(login.headers()['content-security-policy'] ?? '', 'frame-ancestors sur le Hub').toContain("frame-ancestors 'self'");
    return 'iframe : 204, frame-ancestors posé';
  } finally {
    await ctx.close();
  }
});

cas(null, 'anti-boucle : trois essais sur une app s\'arrêtent, une autre app reste ouverte', async ({ browser }) => {
  const ctx = await browser.newContext();
  const prepare = (app: AppKey) =>
    ctx.request.get(`${HUB_URL}/api/auth/bounce/prepare?auto=1&next=${encodeURIComponent(`${APP_URL[app]}/`)}`, {
      maxRedirects: 0,
    });
  const [a, b] = APPS.length > 1 ? [APPS[0], APPS[1]] : [APPS[0], null];
  try {
    await prepare(a);
    await prepare(a);
    const stop = await prepare(a);
    expect(stop.headers().location ?? '', 'troisième essai sur la même app').toContain('bounce_failed=1');
    if (!b) return 'une seule app ici : arrêt au troisième essai';
    const autre = await prepare(b);
    expect(autre.headers().location ?? '', 'autre app, juste après').toContain('mode=bounce');
    return `${a} arrêtée au troisième essai, ${b} toujours ouverte`;
  } finally {
    await ctx.close();
  }
});

/** Les deux coupures totales partagent leur preuve : Hub, cookie rejoué, et chaque app. */
async function prouverCoupure(browser: Browser, c: Compte, couper: () => Promise<void>) {
  const ctx = await contexteDe(browser, c);
  try {
    for (const app of APPS) await ouvrirApp(ctx, app);
    const avant = await Promise.all(APPS.map((a) => voirApp(ctx, a, '/')));
    const fermees = APPS.filter((_, i) => !avant[i].connecte);
    if (fermees.length) throw new NonAbouti(`pas de session avant la coupure sur ${fermees.join(', ')} : rien à prouver`);
    const valeur = cookieHub(await ctx.cookies(HUB_URL));
    const vole = await navigateurAvec(browser, valeur);
    try {
      expect(await sessionHub(vole), 'témoin : le cookie copié ouvre le Hub avant la coupure').toBeTruthy();
    } finally {
      await vole.close();
    }
    await couper();
    expect(await sessionHub(ctx), 'session Hub après la coupure').toBeFalsy();
    // Le cookie d'avant, rejoué ailleurs. Deux passages : le premier fait réécrire le jeton par le
    // middleware, c'est le second qui montrerait une révocation contournée.
    const rejoue = await navigateurAvec(browser, valeur);
    try {
      expect(await dashboardOuvert(rejoue), 'cookie rejoué : premier passage').toBe(false);
      expect(await dashboardOuvert(rejoue), 'cookie rejoué : second passage').toBe(false);
    } finally {
      await rejoue.close();
    }
    const restes: string[] = [];
    for (const app of APPS) {
      const v = await voirApp(ctx, app, '/');
      if (v.connecte) restes.push(`${app} (${v.chemin})`);
    }
    // Dans le message : le rapport n'en garde que trois lignes, et il faut y lire quelle app a survécu.
    expect(restes.join(', '), `apps encore ouvertes après la coupure : ${restes.join(', ')}`).toBe('');
    return `Hub, cookie rejoué et ${APPS.length} app(s) coupés`;
  } finally {
    await ctx.close();
  }
}

cas(null, 'se déconnecter partout : le Hub et les apps coupent, la reconnexion marche', async ({ browser }) => {
  const C = await compte(browser, 'C');
  if (!SUR_STAGING) assurerRybbit(C);
  const detail = await prouverCoupure(browser, C, async () => {
    if (sabote('partout')) return;
    const ctx = await contexteDe(browser, C);
    const res = await ctx.request.post(`${HUB_URL}/api/account/sessions/revoke-all`);
    await ctx.close();
    expect(res.status(), 'déconnexion partout').toBe(200);
  });
  // Une révocation qui enferme dehors serait pire que le mal : on revient avec le mot de passe.
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type=email], input[name=email]').first().fill(C.email);
    await page.locator('input[type=password]').first().fill(C.motDePasse);
    await page.getByRole('button', { name: /^Se connecter$/i }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/dashboard'), { timeout: 45_000 });
    expect(await sessionHub(ctx), 'reconnexion après la coupure').toBeTruthy();
  } finally {
    await ctx.close();
  }
  return `${detail}, reconnexion réussie`;
}, { timeout: 420_000 });

cas(null, 'compte supprimé : plus aucun accès, avec sa session encore en main', async ({ browser }) => {
  const D = await compte(browser, 'D');
  if (!SUR_STAGING) assurerRybbit(D);
  return prouverCoupure(browser, D, async () => {
    if (sabote('supprime')) return;
    await supprimerTenantHub(D.email);
  });
}, { timeout: 420_000 });
