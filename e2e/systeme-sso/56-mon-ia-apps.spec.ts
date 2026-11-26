/**
 * Mon IA depuis une app (VER-203, CONTRAT-HUB §5.24 et §5.24.1) : l'app ne montre la fenêtre du Hub que si elle peut répondre.
 * Compte d'essai neuf, app ouverte par le rebond :
 * 1. sans moteur : `[data-mon-ia="sans_moteur"]`, le bouton « Relier mon IA » ouvre `[data-carte="relier-mon-ia"]` (lien vers
 *    {HUB}/dashboard/ia, nouvel onglet), et AUCUN cadre {HUB}/ia/chat, avant ni après le clic ;
 * 2. une clé branchée (modèle `:free`, 0 $), après le cache de 60 s de l'app : `[data-mon-ia="prete"]`, le bouton « Mon IA » ouvre le
 *    dialogue et insère le cadre pour l'organisation (jamais avant le clic), une question passe par la porte,
 *    et le fil est rangé chez l'app puis relu par le Hub (GET <app>/api/hub/ia/fils/:session).
 * Le branchement et l'activation sont retirés à la fin. Une app qui ne sert encore aucun `[data-mon-ia]` : NON ABOUTI (pas encore servie). Sélecteurs : ceux d'Analytics (26/11), communs aux apps.
 * Épreuve : `SSO_SABOTAGE=carte-absente` attend « prete » sans moteur : le cas doit échouer.
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';

import { APP_URL, HUB_URL, type AppKey } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { secretDe } from './lib/hub-admin';
import { contexteDe } from './lib/monde';
import { creerCompteProuve, ouvrirApp } from './lib/parcours';

const MODELE_GRATUIT = 'nvidia/nemotron-3-ultra-550b-a55b:free'; // même modèle que la recette (0 $, vérifié le 22/11)
/** Les apps à fenêtre dont le bouton est annoncé servi. Academy et Mail s'ajoutent ici quand elles le servent. */
const APPS: { app: AppKey & ('analytics' | 'notifuse'); chemin: string }[] = [{ app: 'analytics', chemin: '/' }];

const cadreDe = (page: Page) => page.locator(`iframe[src^="${HUB_URL}/ia/chat"]`);

async function pageApp(ctx: BrowserContext, app: AppKey, chemin: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${APP_URL[app]}${chemin}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^Plus tard$/ }).click({ timeout: 5_000 }).catch(() => {});
  return page;
}

for (const { app, chemin } of APPS) {
  cas(app, `Mon IA depuis ${app} : la carte sans moteur, jamais la fenêtre ; avec une clé, la fenêtre répond et le fil est rangé chez l'app`, async ({ browser }) => {
    const E = await creerCompteProuve(browser, `monia-${app}`);
    if (!E.tenantId) throw new NonAbouti('compte d\'essai sans organisation');
    const ctx = await contexteDe(browser, E);
    const api = ctx.request;
    try {
      await ouvrirApp(ctx, app);

      // 1. Sans moteur : l'élément flottant dit « sans_moteur », le bouton « Relier mon IA » ouvre la carte, et jamais un cadre (avant ni après le clic).
      const p1 = await pageApp(ctx, app, chemin);
      const zone = p1.locator('[data-mon-ia]').first();
      if (!(await zone.waitFor({ timeout: 20_000 }).then(() => true, () => false))) throw new NonAbouti(`${app} ne sert encore aucun élément [data-mon-ia]`);
      if (process.env.SSO_SABOTAGE === 'carte-absente') expect(await zone.getAttribute('data-mon-ia'), 'épreuve : « prete » attendu sans moteur').toBe('prete');
      expect(await zone.getAttribute('data-mon-ia'), 'sans moteur : l\'app a lu sans_moteur').toBe('sans_moteur');
      expect(await cadreDe(p1).count(), 'sans moteur, avant le clic : aucun cadre').toBe(0);
      await p1.getByRole('button', { name: 'Relier mon IA', exact: true }).click({ timeout: 10_000 });
      const carte = p1.locator('[data-carte="relier-mon-ia"]');
      await expect(carte, 'la carte du connecteur').toBeVisible({ timeout: 10_000 });
      const lien = carte.getByRole('link', { name: 'Relier mon IA', exact: true });
      expect([await lien.getAttribute('href'), await lien.getAttribute('target')], 'la carte mène au connecteur du Hub, nouvel onglet').toEqual([`${HUB_URL}/dashboard/ia`, '_blank']);
      expect((await carte.innerText()).toLowerCase(), 'jamais le mot « clé » proposé').not.toMatch(/\bcl[ée]s?\b/);
      await p1.waitForTimeout(2_000);
      expect(await cadreDe(p1).count(), 'sans moteur, après le clic : aucun cadre').toBe(0);
      await p1.screenshot({ path: `.run/captures/mon-ia-${app}-sans-moteur.png` });
      await p1.close();

      // 2. Une clé branchée : « prete » (après le cache de 60 s de l'app), le bouton « Mon IA » ouvre le dialogue et le cadre pour l'organisation.
      const b = await api.post(`${HUB_URL}/api/ia/branchement`, { data: { fournisseur: 'openrouter', modele: MODELE_GRATUIT, cle: secretDe('OPENROUTER_API_KEY') } });
      if (b.status() !== 200) throw new NonAbouti(`branchement : HTTP ${b.status()}`);
      await new Promise((ok) => setTimeout(ok, 61_000)); // l'app garde l'état 60 s (§5.24.1)
      const p2 = await pageApp(ctx, app, chemin);
      await expect(p2.locator('[data-mon-ia]').first(), 'avec un moteur : l\'app a lu prete').toHaveAttribute('data-mon-ia', 'prete', { timeout: 20_000 });
      expect(await cadreDe(p2).count(), 'avant le clic : pas de cadre inséré').toBe(0);
      await p2.getByRole('button', { name: 'Mon IA', exact: true }).click({ timeout: 10_000 });
      await expect(p2.getByRole('dialog', { name: 'Mon IA' }), 'le dialogue « Mon IA »').toBeVisible({ timeout: 10_000 });
      const cadre = cadreDe(p2).first();
      await cadre.waitFor({ timeout: 30_000 });
      const src = new URL((await cadre.getAttribute('src')) ?? '');
      expect([src.searchParams.get('app'), src.searchParams.get('tenant')], 'cadre ouvert pour l\'app et l\'organisation du compte').toEqual([app, E.tenantId]);
      await expect(p2.frameLocator(`iframe[src^="${HUB_URL}/ia/chat"]`).first().getByLabel('Votre question'), 'avec un moteur : la saisie dans le cadre').toBeVisible({ timeout: 30_000 });
      await p2.screenshot({ path: `.run/captures/mon-ia-${app}.png` });
      await p2.close();

      const question = { app, tenantId: E.tenantId, messages: [{ id: 'q1', role: 'user', parts: [{ type: 'text', text: 'Quels sont mes plans Veridian ? Utilise hub.mon_compte par les outils, puis réponds en une phrase.' }] }] };
      const c = await api.post(`${HUB_URL}/api/ia/chat`, { data: question, timeout: 120_000 });
      const flux = await c.text();
      if (c.status() === 429) throw new NonAbouti('plafond du fournisseur gratuit atteint : chat non joué');
      expect(c.status(), flux.slice(0, 160)).toBe(200);
      const session = /"sessionId":"([0-9a-f-]{36})"/.exec(flux)?.[1];
      expect(session, 'le Hub rend la session du fil').toBeTruthy();
      let messages: unknown[] = [];
      for (let i = 0; i < 10 && messages.length === 0; i++) {
        const f = await api.get(`${HUB_URL}/api/ia/fil?app=${app}&session=${session}&tenant=${E.tenantId}`);
        messages = f.status() === 200 ? (((await f.json().catch(() => null)) as { messages?: unknown[] } | null)?.messages ?? []) : [];
        if (!messages.length) await new Promise((ok) => setTimeout(ok, 2_000));
      }
      expect(messages.length, `le fil relu chez ${app} contient la question et la réponse`).toBeGreaterThanOrEqual(2);
      return `sans moteur : carte « Relier mon IA » vers ${HUB_URL}/dashboard/ia, aucun cadre ; clé branchée : cadre ?app=${app} ouvert, saisie, réponse 200, fil de ${messages.length} message(s) rangé chez ${app} et relu`;
    } finally {
      await api.post(`${HUB_URL}/api/ia/activation`, { data: { app, tenantId: E.tenantId, enabled: false } }).catch(() => undefined);
      await api.delete(`${HUB_URL}/api/ia/branchement?fournisseur=openrouter`).catch(() => undefined);
      await ctx.close();
    }
  });
}
