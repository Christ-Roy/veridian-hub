/**
 * Connexions à des services extérieurs : FERMÉES (parente, 25/11). Rien au menu, « brancher » refusé avant tout départ, rien n'est offert à une IA.
 * JAMAIS de service réel ici : partir chez l'un d'eux y inscrit un client au nom de Veridian. L'échange complet se joue en tests contre un service jetable
 * (__tests__/lib/connecteurs) ; le premier service réel est un geste de Robert.
 * Épreuve : `SSO_SABOTAGE=connecteurs-fermes` cherche l'entrée au menu : le cas doit échouer.
 */
import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas } from './lib/etat';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, type Compte } from './lib/parcours';

cas(null, 'connexions : fermées, aucun départ vers un service extérieur', async ({ browser }) => {
  const A: Compte = await creerCompteProuve(browser, 'connect', undefined, true);
  const ctx = await browser.newContext({ storageState: A.etat as never });
  try {
    const page = await ctx.newPage();
    const dehors: string[] = [];
    page.on('request', (r) => { if (r.isNavigationRequest() && new URL(r.url()).origin !== new URL(HUB_URL).origin) dehors.push(new URL(r.url()).host); });
    await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' });
    expect(await page.getByRole('link', { name: 'Connexions', exact: true }).count(), 'au menu').toBe(process.env.SSO_SABOTAGE === 'connecteurs-fermes' ? 1 : 0);
    await page.goto(`${HUB_URL}/dashboard/connexions`, { waitUntil: 'networkidle' });
    await page.getByText('pas encore ouverte').first().waitFor();
    expect(await page.getByRole('button', { name: /Brancher/ }).count()).toBe(0);
    for (const c of ['notion', 'linear', 'webflow', 'sentry']) {
      const r = await ctx.request.post(`${HUB_URL}/api/connecteurs`, { headers: { origin: new URL(HUB_URL).origin }, form: { connecteur: c, geste: 'brancher' }, maxRedirects: 0 });
      expect(r.headers().location, `${c} forcé sans l'écran`).toContain('avis=ferme');
    }
    // Couper n'est pas fermé : sans connexion, la route le dit, au lieu de « pas encore ouverte ».
    const coupe = await ctx.request.post(`${HUB_URL}/api/connecteurs`, { headers: { origin: new URL(HUB_URL).origin }, form: { connecteur: 'notion', geste: 'couper' }, maxRedirects: 0 });
    expect(coupe.headers().location, 'couper répond').toContain('avis=absente');
    const apps = JSON.parse((await outil(await obtenirJetonMcp(browser, A, 'TEST CONNECTEURS'), 'chercher_outils', { besoin: 'page' })).texte) as { apps: string[] };
    expect(apps.apps.filter((a) => ['notion', 'linear', 'webflow', 'sentry'].includes(a))).toEqual([]);
    expect(dehors, 'navigations hors du Hub').toEqual([]);
    return 'rien au menu, brancher refusé pour les quatre, aucun départ';
  } finally {
    await ctx.close();
  }
});
