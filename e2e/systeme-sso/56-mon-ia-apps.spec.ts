/**
 * Mon IA depuis une app (VER-203, CONTRAT-HUB §5.24 et §5.24.1) : l'app ne montre la fenêtre du Hub que si elle peut répondre.
 * Compte d'essai neuf, app ouverte par le rebond :
 * 1. sans moteur : la carte « Relier mon IA » (lien vers {HUB}/dashboard/ia), et AUCUN cadre {HUB}/ia/chat dans la page ;
 * 2. une clé branchée (modèle `:free`, 0 $) : le bouton « Mon IA » insère le cadre pour l'organisation, une question passe par la porte,
 *    et le fil est rangé chez l'app puis relu par le Hub (GET <app>/api/hub/ia/fils/:session).
 * Le branchement et l'activation sont retirés à la fin. Une app qui ne sert encore ni bouton ni carte : NON ABOUTI (pas encore servie).
 * Épreuve : `SSO_SABOTAGE=carte-absente` attend le cadre sans moteur : le cas doit échouer.
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

      // 1. Sans moteur : la carte, jamais le cadre (l'app a lu POST /api/ia/etat → sans_moteur).
      const p1 = await pageApp(ctx, app, chemin);
      const carte = p1.getByText(/Relier mon IA/).first();
      const vue = await carte.waitFor({ timeout: 20_000 }).then(() => true, () => false);
      const bouton = await p1.getByRole('button', { name: /Mon IA/ }).count();
      if (!vue && bouton === 0) throw new NonAbouti(`${app} ne sert encore ni la carte « Relier mon IA » ni le bouton « Mon IA »`);
      await p1.waitForTimeout(3_000);
      if (process.env.SSO_SABOTAGE === 'carte-absente') expect(await cadreDe(p1).count(), 'épreuve : cadre attendu sans moteur').toBeGreaterThan(0);
      expect(vue, 'sans moteur : la carte « Relier mon IA » est visible').toBe(true);
      expect(await cadreDe(p1).count(), 'sans moteur : aucun cadre de la fenêtre').toBe(0);
      const lien = await p1.getByRole('link', { name: /Relier mon IA/ }).first().getAttribute('href').catch(() => null);
      expect(lien ?? '', 'la carte mène au connecteur du Hub').toContain(`${HUB_URL}/dashboard/ia`);
      expect((await p1.locator('body').innerText()).toLowerCase(), 'jamais le mot « clé » proposé').not.toMatch(/\bcl[ée] d'api\b|\bvotre cl[ée]\b/);
      await p1.screenshot({ path: `.run/captures/mon-ia-${app}-sans-moteur.png` });
      await p1.close();

      // 2. Une clé branchée : le bouton insère le cadre pour l'organisation ; une question ; le fil rangé chez l'app.
      const b = await api.post(`${HUB_URL}/api/ia/branchement`, { data: { fournisseur: 'openrouter', modele: MODELE_GRATUIT, cle: secretDe('OPENROUTER_API_KEY') } });
      if (b.status() !== 200) throw new NonAbouti(`branchement : HTTP ${b.status()}`);
      await new Promise((ok) => setTimeout(ok, 61_000)); // l'app peut garder l'état 60 s (§5.24.1)
      const p2 = await pageApp(ctx, app, chemin);
      await p2.getByRole('button', { name: /Mon IA/ }).first().click({ timeout: 20_000 });
      const cadre = cadreDe(p2).first();
      await cadre.waitFor({ timeout: 30_000 });
      const src = new URL((await cadre.getAttribute('src')) ?? '');
      expect([src.searchParams.get('app'), src.searchParams.get('tenant')], 'cadre ouvert pour l\'app et l\'organisation du compte').toEqual([app, E.tenantId]);
      await expect(p2.frameLocator(`iframe[src^="${HUB_URL}/ia/chat"]`).first().getByLabel('Votre question'), 'avec un moteur : la saisie').toBeVisible({ timeout: 30_000 });
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
