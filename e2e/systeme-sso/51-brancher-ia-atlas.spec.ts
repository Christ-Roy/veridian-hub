/**
 * Mon IA depuis Prospection (VER-203, parente 26/11) : « Brancher une IA » dans Atlas mène au connecteur du Hub (porte MCP), jamais
 * à une clé ; l'IA branchée une fois au Hub agit ensuite dans Prospection, puis dans une autre app, sans aucun clic de plus.
 * Compte et organisation d'essai (e2e-sso-…@veridian.site), retirés par le nettoyage de la batterie.
 * Épreuve : `SSO_SABOTAGE=brancher-ia-cle` cherche une demande de clé à la place du lien du Hub : le cas doit échouer.
 */
import { expect } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { contexteDe } from './lib/monde';
import { creerCompteProuve, ouvrirApp } from './lib/parcours';

cas('prospection', 'Mon IA : « Brancher une IA » dans Atlas mène au connecteur du Hub, puis l\'IA agit dans Prospection et ailleurs sans clic', async ({ browser }) => {
  const E = await creerCompteProuve(browser, 'brancheria');
  const ctx = await contexteDe(browser, E);
  let liens: string[] = [];
  try {
    await ouvrirApp(ctx, 'prospection');
    const page = await ctx.newPage();
    await page.goto(`${APP_URL.prospection}/`, { waitUntil: 'networkidle' });
    // Compte neuf : l'accueil « Bienvenue dans Atlas » propose « Avec mon IA » ; le rail porte le même geste.
    await page.getByRole('button', { name: /^Plus tard$/ }).click({ timeout: 5_000 }).catch(() => {});
    await page.locator('[title="Brancher Claude, ChatGPT ou Cursor"]').first().click({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: '.run/captures/brancher-ia-atlas.png' });
    liens = await page.locator('a[href]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    const demandeCle = await page.locator('input[type=password], input[name*=key i], input[placeholder*="clé" i]').count();
    if (process.env.SSO_SABOTAGE === 'brancher-ia-cle') expect(demandeCle, 'une demande de clé (épreuve)').toBeGreaterThan(0);
    expect(demandeCle, 'aucune clé demandée : le connecteur suffit').toBe(0);
  } finally {
    await ctx.close();
  }
  const hub = new URL(HUB_URL).host;
  const versHub = liens.filter((l) => l.includes(hub) || l.includes(encodeURIComponent(hub)));
  expect(versHub.length, `liens du dialogue vers le Hub (${liens.length} liens lus)`).toBeGreaterThan(0);

  // Le branchement : le même OAuth qu'un client IA réel, par la porte du Hub.
  const jeton = await obtenirJetonMcp(browser, E, 'TEST BRANCHER IA');
  const trouve = JSON.parse((await outil(jeton, 'chercher_outils', { besoin: 'mes droits quota', app: 'prospection' })).texte) as { outils?: { nom: string }[] };
  const choisi = (trouve.outils ?? []).find((o) => /mes_droits|quota|compte/.test(o.nom));
  if (!choisi) throw new NonAbouti(`aucun outil de lecture Prospection trouvé par la porte (${(trouve.outils ?? []).map((o) => o.nom).join(', ').slice(0, 160)})`);
  const r = await outil(jeton, 'executer_outil', { nom: choisi.nom });
  expect(r.isError, `${choisi.nom} : ${r.texte.slice(0, 160)}`).toBe(false);
  // Ailleurs, sans clic : le même jeton agit aussi au Hub, aucun nouveau consentement.
  const compte = await outil(jeton, 'executer_outil', { nom: 'hub.mon_compte' });
  expect(compte.isError).toBe(false);
  return `dialogue Atlas : ${versHub.length} lien(s) vers le connecteur du Hub, aucune clé demandée ; ${choisi.nom} reçu par Prospection ; hub.mon_compte lu par le même jeton, sans clic`;
});
