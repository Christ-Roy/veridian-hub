/**
 * Mon IA depuis une app (VER-203, CONTRAT-HUB §5.24 et §5.24.1) : l'app ne montre la fenêtre du Hub que si elle peut répondre.
 * Compte d'essai neuf, app ouverte par le rebond :
 * 1. sans moteur : `[data-mon-ia="sans_moteur"]`, le bouton « Relier mon IA » ouvre `[data-carte="relier-mon-ia"]` (lien vers
 *    {HUB}/dashboard/ia, nouvel onglet), et AUCUN cadre {HUB}/ia/chat, avant ni après le clic ;
 * 2. une clé branchée (modèle `:free`, 0 $), après le cache de 60 s de l'app : `[data-mon-ia="prete"]`, le bouton « Mon IA » ouvre le
 *    dialogue et insère le cadre pour l'organisation (jamais avant le clic), une question passe par la porte,
 *    et le fil est rangé chez l'app puis relu par le Hub (GET <app>/api/hub/ia/fils/:session).
 * Le branchement et l'activation sont retirés à la fin. Une app qui ne sert encore aucun `[data-mon-ia]` : NON ABOUTI (pas encore servie). Sélecteurs : ceux d'Analytics (26/11), communs aux apps.
 * Les marques data-* et la cible du lien sont fixes ; les libellés se traduisent selon la langue de l'interface (Mail, 27/11).
 * Épreuves : `SSO_SABOTAGE=carte-absente` attend « prete » sans moteur ; `SSO_SABOTAGE=fil-autre-session` relit une autre session :
 * le fil ne doit pas revenir. Chacune doit faire échouer le cas.
 */
import { randomUUID } from 'node:crypto';

import { expect, type BrowserContext, type Page } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { adminOk, secretDe } from './lib/hub-admin';
import { contexteDe } from './lib/monde';
import { creerCompteProuve, ouvrirApp } from './lib/parcours';

const MODELE_GRATUIT = 'nvidia/nemotron-3-ultra-550b-a55b:free'; // même modèle que la recette (0 $, vérifié le 22/11)
const ACADEMY_URL = process.env.ACADEMY_URL || 'https://academy.app.veridian.site';
type AppFenetre = 'analytics' | 'notifuse' | 'prospection' | 'academy';
/** Les apps à fenêtre dont le bouton est annoncé servi. `chemin` : une page connectée où vivent les marques communes. */
const APPS: { app: AppFenetre; chemin: string }[] = [
  { app: 'analytics', chemin: '/' },
  { app: 'prospection', chemin: '/' }, // Atlas : reprend le cas 53 (26/11), Prospection sert la règle depuis 316bbf4
  // Academy : une organisation dont tous les membres sont e2e-sso entre par le rebond (exemption d'épreuve, b6996c1, parente 26/11).
  { app: 'academy', chemin: '/cours/environnement/dossier-au-tresor' },
  { app: 'notifuse', chemin: '/' }, // Mail : sert §5.24 et §5.24.1 depuis f7eb4e68 (27/11)
];
/** Les apps qui servent la carte enrichie (installation en un clic, adresse MCP, commande) ; les autres s'y ajoutent quand elles la servent. */
const CARTE_ENRICHIE = new Set<AppFenetre>(['academy', 'prospection', 'analytics', 'notifuse']);
const urlDe = (app: AppFenetre) => (app === 'academy' ? ACADEMY_URL : APP_URL[app]);

/** Ouvre l'app pour l'organisation du compte, puis y entre par le rebond du Hub. Academy : ouverte par la route d'administration (comme la recette, cas 50). */
async function entrerDans(ctx: BrowserContext, app: AppFenetre, tenantId: string): Promise<void> {
  if (app !== 'academy') return void (await ouvrirApp(ctx, app));
  const o = await adminOk<{ apps: { app: string; etat: string; detail?: string }[] }>('POST', `tenants/${tenantId}/ouvrir`, { apps: ['academy'] });
  const a = o.apps.find((x) => x.app === 'academy');
  if (a?.etat !== 'ouverte') throw new NonAbouti(`Academy non ouverte pour l'organisation : ${a?.etat ?? 'absente'} ${a?.detail ?? ''}`);
  const page = await ctx.newPage();
  await page.goto(`${HUB_URL}/login?next=${encodeURIComponent(`${ACADEMY_URL}/`)}`, { waitUntil: 'domcontentloaded' });
  const cible = new URL(ACADEMY_URL).host;
  await page.waitForURL((u) => u.host === cible || /\/auth\/bounce\/error/.test(u.pathname), { timeout: 60_000 });
  if (/\/auth\/bounce\/error/.test(new URL(page.url()).pathname)) throw new Error(`rebond vers Academy refusé : ${new URL(page.url()).searchParams.get('code')}`);
  await page.close();
}

/** Une proposition de clé, mot entier (frontières Unicode) : « votre clé », « une clé », « clé d'API », « API key ». « sans clé » n'en est pas une. */
const PROPOSE_UNE_CLE = /(?<![\p{L}\p{N}])(?:votre|vos|une|la|des|sa|ta)\s+cl[ée]s?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])cl[ée]s?\s+(?:d['\u2019]\s?api|api)(?![\p{L}\p{N}])|\bapi[\s-]?key\b/iu;

const cadreDe = (page: Page) => page.locator(`iframe[src^="${HUB_URL}/ia/chat"]`);

/**
 * Un seul point d'entrée IA par app (parente, 27/11 : Mail affichait « Connect my AI » à côté de « Brancher mon IA »). Lu sans la langue :
 * une seule marque [data-mon-ia], et hors d'elle aucun lien ni cadre vers le connecteur ({HUB}/dashboard/ia) ou la fenêtre ({HUB}/ia/chat).
 * `SSO_SABOTAGE=double-entree` ajoute un tel lien hors de la marque : le cas doit échouer.
 */
async function unSeulPointDEntree(page: Page): Promise<void> {
  if (process.env.SSO_SABOTAGE === 'double-entree') {
    await page.evaluate((h) => { const a = document.createElement('a'); a.href = `${h}/dashboard/ia`; a.textContent = 'Brancher mon IA'; document.body.appendChild(a); }, HUB_URL);
  }
  const marques = await page.locator('[data-mon-ia]').count();
  const dehors = await page.evaluate((h) => Array.from(document.querySelectorAll('a[href], iframe[src]'))
    .filter((e) => !e.closest('[data-mon-ia]'))
    .map((e) => (e as HTMLAnchorElement).href || (e as HTMLIFrameElement).src)
    .filter((u) => u.startsWith(`${h}/dashboard/ia`) || u.startsWith(`${h}/ia/chat`)), HUB_URL);
  expect({ marques, dehors }, "un seul point d'entrée IA : une marque data-mon-ia, rien vers le Hub IA hors d'elle").toEqual({ marques: 1, dehors: [] });
}

async function pageApp(ctx: BrowserContext, app: AppFenetre, chemin: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${urlDe(app)}${chemin}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^Plus tard$/ }).click({ timeout: 5_000 }).catch(() => {});
  // Mail ouvre la console sur le choix de l'espace : la marque ne vit que dans un espace. On entre dans celui du compte (son identifiant
  // s'affiche « ID: e2esso… », sans dépendre de la langue).
  if (app === 'notifuse' && /\/console\/?$/.test(new URL(page.url()).pathname)) {
    await page.getByText(/ID:\s*e2esso/).first().click({ timeout: 15_000 });
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }
  return page;
}

// SSO_MON_IA_APP=academy : une seule app (rejeu ciblé).
for (const { app, chemin } of APPS.filter((x) => !process.env.SSO_MON_IA_APP || x.app === process.env.SSO_MON_IA_APP)) {
  cas(app === 'academy' ? null : app, `Mon IA depuis ${app} : la carte sans moteur, jamais la fenêtre ; avec une clé, la fenêtre répond et le fil est rangé chez l'app`, async ({ browser }) => {
    const E = await creerCompteProuve(browser, `monia-${app}`);
    if (!E.tenantId) throw new NonAbouti('compte d\'essai sans organisation');
    const ctx = await contexteDe(browser, E);
    const api = ctx.request;
    try {
      await entrerDans(ctx, app, E.tenantId);

      // 1. Sans moteur : l'élément flottant dit « sans_moteur », le bouton « Relier mon IA » ouvre la carte, et jamais un cadre (avant ni après le clic).
      const p1 = await pageApp(ctx, app, chemin);
      const zone = p1.locator('[data-mon-ia]').first();
      // Présent dans la page, pas forcément visible : chez Academy la marque est un conteneur sans taille autour d'un bouton fixe (27/11).
      if (!(await zone.waitFor({ state: 'attached', timeout: 20_000 }).then(() => true, () => false))) {
        // Ce que la page montre à la place : l'adresse atteinte et le début du texte, pour qu'un NON ABOUTI se diagnostique sans rejouer.
        await p1.screenshot({ path: `.run/captures/mon-ia-${app}-sans-marque.png` });
        const u = new URL(p1.url());
        const vu = (await p1.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
        throw new NonAbouti(`${app} ne sert aucun élément [data-mon-ia] sur ${u.host}${u.pathname} (page : « ${vu} »)`);
      }
      if (process.env.SSO_SABOTAGE === 'carte-absente') expect(await zone.getAttribute('data-mon-ia'), 'épreuve : « prete » attendu sans moteur').toBe('prete');
      expect(await zone.getAttribute('data-mon-ia'), 'sans moteur : l\'app a lu sans_moteur').toBe('sans_moteur');
      expect(await cadreDe(p1).count(), 'sans moteur, avant le clic : aucun cadre').toBe(0);
      await unSeulPointDEntree(p1);
      // Le bouton de la marque, quel que soit son libellé (traduit selon la langue de l'interface, §5.24.1).
      // La marque peut porter le bouton (Prospection) ou l'entourer (Analytics, Academy).
      await p1.locator('button[data-mon-ia], [data-mon-ia] button').first().click({ timeout: 10_000 });
      const carte = p1.locator('[data-carte="relier-mon-ia"]');
      await expect(carte, 'la carte du connecteur').toBeVisible({ timeout: 10_000 });
      const lien = carte.locator(`a[href="${HUB_URL}/dashboard/ia"]`).first();
      expect([await lien.getAttribute('href'), await lien.getAttribute('target')], 'la carte mène au connecteur du Hub, nouvel onglet').toEqual([`${HUB_URL}/dashboard/ia`, '_blank']);
      // Atteignable à l'écran, pas seulement présent dans la page (27/11 : carte d'Academy coupée sous la commande à 1280×720).
      // Épreuve `carte-coupee` : la carte rognée sans défilement ; le lien final sort de l'écran, le cas doit échouer.
      if (process.env.SSO_SABOTAGE === 'carte-coupee') await carte.evaluate((el) => { const c = el as HTMLElement; c.style.maxHeight = '60px'; c.style.overflow = 'hidden'; c.style.position = 'fixed'; c.style.top = '0'; });
      // Comme un utilisateur : la molette sur la carte (27/11 : scrollIntoView fait défiler même un overflow:hidden, l'épreuve passait).
      await carte.hover({ timeout: 5_000 }).catch(() => undefined);
      for (let i = 0; i < 6; i++) await p1.mouse.wheel(0, 600);
      await p1.waitForTimeout(500);
      await expect(lien, 'le lien final de la carte est atteignable à l\'écran').toBeInViewport({ timeout: 5_000 });
      // Jamais une clé PROPOSÉE (« votre clé », « clé d'API », un champ) ; « sans clé » est l'assurance du contrat (Prospection, 26/11 : l'ancien
      // \bcl[ée]\b ne tenait que par accident, \b sans drapeau u ne voit pas la frontière après « é »).
      expect(await carte.innerText(), 'aucune clé proposée').not.toMatch(PROPOSE_UNE_CLE);
      expect(await carte.locator('textarea, input:not([readonly])').count(), 'aucun champ de saisie dans la carte').toBe(0);
      // Carte enrichie (§5.24.1, parente 27/11) : les liens lus chez le Hub, un par entrée d'assistants[] (jamais un nombre fixe),
      // l'adresse MCP et la commande Claude Code. Seulement pour les apps qui la servent déjà.
      if (CARTE_ENRICHIE.has(app)) {
        const l = (await (await fetch(`${HUB_URL}/api/mcp/liens-installation?app=${app}`)).json()) as { url: string; claudeCode: string; assistants: { cle: string; installation: string }[] };
        const vu = await carte.evaluate((el) => ({
          liens: Array.from(el.querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? ''),
          texte: `${(el as HTMLElement).innerText} ${Array.from(el.querySelectorAll('input')).map((i) => (i as HTMLInputElement).value).join(' ')}`,
        }));
        expect(l.assistants.filter((a) => !vu.liens.includes(a.installation)).map((a) => a.cle), 'carte : un bouton par assistant, lien du Hub').toEqual([]);
        expect([vu.texte.includes(l.url), vu.texte.includes(l.claudeCode)], 'carte : adresse MCP et commande Claude Code').toEqual([true, true]);
      }
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
      await unSeulPointDEntree(p2);
      await p2.locator('button[data-mon-ia="prete"], [data-mon-ia="prete"] button').first().click({ timeout: 10_000 });
      await expect(p2.getByRole('dialog').first(), 'le dialogue de l\'assistant').toBeVisible({ timeout: 10_000 });
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
        const lue = process.env.SSO_SABOTAGE === 'fil-autre-session' ? randomUUID() : session!;
        const f = await api.get(`${HUB_URL}/api/ia/fil?app=${app}&session=${lue}&tenant=${E.tenantId}`);
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
