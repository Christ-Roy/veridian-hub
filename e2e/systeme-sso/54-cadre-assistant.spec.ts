/**
 * Qui peut encadrer la fenêtre de l'assistant (/ia/chat) : une app Veridian (*.app.veridian.site), jamais un site tiers (VER-265, 26/11 :
 * la CSP bloquante avait effacé frame-ancestors ; un site tiers pouvait encadrer la fenêtre et faire cliquer « Autoriser »).
 * Session ouverte : une page de Prospection encadre la fenêtre, elle se charge ; une page tierce encadre la même adresse, le navigateur refuse.
 * Épreuve : `SSO_SABOTAGE=cadre-tiers` attend le refus depuis Prospection aussi : le cas doit échouer.
 */
import { expect, type Page } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { contexteDe } from './lib/monde';
import { creerCompteProuve } from './lib/parcours';

/** Encadre la fenêtre dans la page courante ; rend vrai si le cadre a chargé la fenêtre, faux si le navigateur a refusé. */
async function encadrer(page: Page, src: string): Promise<{ charge: boolean; refus: string | null }> {
  let refus: string | null = null;
  page.on('console', (m) => { if (/Refused to (frame|display)|frame-ancestors/i.test(m.text())) refus = m.text().slice(0, 160); });
  await page.evaluate((s) => { const f = document.createElement('iframe'); f.id = 'cadre-assistant'; f.src = s; f.style.width = '600px'; f.style.height = '400px'; document.body.appendChild(f); }, src);
  await page.waitForTimeout(6_000);
  const f = page.frames().find((x) => x.url().startsWith(`${HUB_URL}/ia/chat`));
  const texte = f ? await f.locator('body').innerText({ timeout: 3_000 }).catch(() => '') : '';
  return { charge: Boolean(f) && texte.length > 0 && !refus, refus };
}

cas(null, 'CSP : la fenêtre de l\'assistant s\'encadre dans une app Veridian, jamais dans un site tiers', async ({ browser }) => {
  const E = await creerCompteProuve(browser, 'cadre');
  if (!E.tenantId) throw new NonAbouti('compte d\'essai sans organisation');
  const src = `${HUB_URL}/ia/chat?app=prospection&tenant=${E.tenantId}`;
  const ctx = await contexteDe(browser, E);
  try {
    const app = await ctx.newPage();
    await app.goto(`${APP_URL.prospection}/`, { waitUntil: 'domcontentloaded' });
    const depuisApp = await encadrer(app, src);
    const tiers = await ctx.newPage();
    await tiers.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => { throw new NonAbouti('page tierce (example.com) injoignable depuis le navigateur'); });
    const depuisTiers = await encadrer(tiers, src);
    await tiers.screenshot({ path: '.run/captures/cadre-tiers-refuse.png' });
    if (process.env.SSO_SABOTAGE === 'cadre-tiers') expect(depuisApp.charge, 'épreuve : refus attendu depuis Prospection').toBe(false);
    expect(depuisApp, 'encadrée par Prospection : la fenêtre se charge').toMatchObject({ charge: true });
    expect(depuisTiers.charge, `encadrée par un site tiers : refusée (${depuisTiers.refus ?? 'aucun message'})`).toBe(false);
    return `depuis ${APP_URL.prospection} : fenêtre chargée ; depuis example.com : refusée (${(depuisTiers.refus ?? 'cadre vide').slice(0, 80)})`;
  } finally {
    await ctx.close();
  }
});
