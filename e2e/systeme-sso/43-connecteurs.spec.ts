/**
 * Connexions à des services extérieurs (VER-119, VER-244) : depuis l'écran, chaque service RÉEL enregistre notre client tout seul et montre SA page de
 * connexion ; un retour refusé, forgé, rejoué ou fini par un autre compte ne branche rien. Captures : .run/captures/.
 * NON PROUVÉ : un consentement réel (il faut un compte chez le service : le clic de Robert). Le parcours complet est joué en tests contre un service jetable.
 * Épreuve : `SSO_SABOTAGE=connecteur-session` retire la session avant de brancher : le cas doit échouer.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, type Compte } from './lib/parcours';
import { RUN_DIR } from './lib/versions';

const SERVICES = ['Notion', 'Linear', 'Canva', 'Webflow', 'Sentry'];

cas(null, 'connexions : chaque service réel s\'ouvre sans application créée ; rien ne se branche sans consentement', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (retour enregistré chez les services)');
  const A: Compte = await creerCompteProuve(browser, 'connect', undefined, true);
  const B: Compte = await creerCompteProuve(browser, 'connect2', undefined, true);
  const ctx = await browser.newContext({ storageState: A.etat as never, viewport: { width: 1280, height: 900 } });
  const autre = await browser.newContext({ storageState: B.etat as never });
  ctx.setDefaultTimeout(45_000);
  try {
    mkdirSync(join(RUN_DIR, 'captures'), { recursive: true });
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Connexions' }).click();
    await page.waitForURL(/\/dashboard\/connexions/);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(RUN_DIR, 'captures', 'connexions.png'), fullPage: true });
    if (process.env.SSO_SABOTAGE === 'connecteur-session') await ctx.clearCookies();

    const arrives: Record<string, string> = {};
    let retour = '';
    for (const nom of SERVICES) {
      await page.goto(`${HUB_URL}/dashboard/connexions`, { waitUntil: 'networkidle' });
      const [depart] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/connecteurs') && r.request().method() === 'POST'), page.getByRole('button', { name: `Brancher ${nom}` }).click()]);
      const lieu = depart.headers().location ?? '';
      arrives[nom] = lieu.includes('avis=') ? lieu : new URL(lieu).host;
      const p = lieu.includes('avis=') ? new URLSearchParams() : new URL(lieu).searchParams;
      expect([p.get('code_challenge_method'), p.get('redirect_uri'), Boolean(p.get('state')), Boolean(p.get('resource'))], `${nom} : ${arrives[nom]}`).toEqual(['S256', `${HUB_URL}/api/connecteurs/retour`, true, true]);
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(4_000);
      // Sa page de connexion à lui, pas une erreur : notre client y est connu.
      const texte = (await page.locator('body').innerText().catch(() => '')).slice(0, 2_000);
      expect(/invalid_client|invalid_redirect|unknown client|redirect_uri mismatch/i.test(texte), `${nom} refuse notre client : ${texte.slice(0, 200)}`).toBe(false);
      expect(new URL(page.url()).origin, `${nom} : toujours chez nous`).not.toBe(new URL(HUB_URL).origin);
      await page.screenshot({ path: join(RUN_DIR, 'captures', `connexion-${nom.toLowerCase()}.png`) });
      retour = `${HUB_URL}/api/connecteurs/retour`;
      const etat = p.get('state');
      // Retour forgé (code inventé, le bon state) : échoue, et rien n'est branché.
      const forge = await ctx.request.get(`${retour}?code=forge&state=${etat}`, { maxRedirects: 0 });
      expect(forge.headers().location, `${nom} : code inventé`).toContain('avis=echec');
      const rejoue = await ctx.request.get(`${retour}?code=forge&state=${etat}`, { maxRedirects: 0 });
      expect(rejoue.headers().location, `${nom} : transaction déjà finie`).toContain('avis=expiree');
    }
    const ailleurs = await autre.request.get(`${retour}?code=x&state=y`, { maxRedirects: 0 });
    expect(ailleurs.headers().location, 'autre compte, sans transaction').toContain('avis=expiree');
    await page.goto(`${HUB_URL}/dashboard/connexions`, { waitUntil: 'networkidle' });
    expect(await page.getByRole('button', { name: /^Couper/ }).count(), 'rien n\'est branché').toBe(0);
    const etranger = await autre.request.post(`${HUB_URL}/api/connecteurs`, { headers: { origin: 'https://pirate.test' }, form: { connecteur: 'notion', geste: 'brancher' }, maxRedirects: 0 });
    expect(etranger.status(), 'depuis une autre page').toBe(403);
    const apps = JSON.parse((await outil(await obtenirJetonMcp(browser, A, 'TEST CONNECTEURS'), 'chercher_outils', { besoin: 'page' })).texte) as { apps: string[] };
    expect(apps.apps.filter((a) => ['notion', 'linear', 'canva', 'webflow', 'sentry'].includes(a)), 'aucun service sans consentement').toEqual([]);
    return Object.entries(arrives).map(([n, h]) => `${n} → ${h}`).join(' ; ');
  } finally {
    await ctx.close();
    await autre.close();
  }
}, { timeout: 600_000 });
