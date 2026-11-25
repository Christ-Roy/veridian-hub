/**
 * Entrer chez un client (VER-263), sur ce qui est servi. Prod et staging, par le lien de `hub open` : l'état dit par app est celui qui se vérifie en entrant,
 * le bandeau est là, aucun geste ne passe au Hub, l'administration reste fermée, le journal dit tout. Staging, par l'écran : un administrateur de plateforme
 * d'épreuve cherche, entre, sort et redevient lui-même ; un compte ordinaire n'y voit rien.
 * NON PROUVÉ en prod : l'écran en session d'administrateur (la liste de prod ne compte que Robert). Captures : .run/captures/emprunt-*.png.
 * Épreuves : `SSO_SABOTAGE=emprunt-geste` (session ordinaire au lieu de l'emprunt), `emprunt-journal` (un autre emprunt relu), `emprunt-retour` (cookie de
 * retour effacé avant de sortir), `emprunt-ordinaire` (l'administrateur d'épreuve à la place du compte ordinaire) : le cas doit échouer.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type BrowserContext, type Page } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, adminOk, lookup } from './lib/hub-admin';
import { adresseDe, creerCompteProuve, noter, noterEspaceTwenty, type Compte } from './lib/parcours';
import { RUN_DIR } from './lib/versions';

/** Réservé dans `deploy/hub-staging.nomad.hcl`, jamais en prod. */
const ADMIN_EPREUVE = 'e2e45000-0000-4000-8000-000000000045';
const STAGING = /staging/.test(HUB_URL);
const sabotage = process.env.SSO_SABOTAGE ?? '';
type Lien = { emprunt: string; links: Record<string, string | null>; apps: { app: string; etat: string; entrable: boolean; detail: string }[] };
type Ligne = { id: string; action: string; payload: Record<string, unknown> | null };

const capture = async (p: Page, nom: string) => { mkdirSync(join(RUN_DIR, 'captures'), { recursive: true }); await p.screenshot({ path: join(RUN_DIR, 'captures', `emprunt-${nom}.png`) }); };
const ouvrir = (email: string) => adminOk<Lien>('POST', 'impersonate', { email, raison: 'épreuve système' });
const session = async (c: BrowserContext) => ((await (await c.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: { email?: string; impersonated?: boolean } } | null)?.user ?? null;
const journal = async (): Promise<Ligne[]> => (await adminOk<{ events: Ligne[] }>('GET', 'audit-log?action=admin.impersonate.start,admin.impersonate.consume,admin.impersonate.app,admin.impersonate.end&limit=200')).events;
const duEmprunt = (l: Ligne[], id: string) => l.filter((x) => x.id === id || x.payload?.emprunt === id);
/** Dans le navigateur, pour que l'origine et les cookies soient les vrais. */
const poster = (p: Page, chemin: string) => p.evaluate(async (u) => { const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual' }); return { statut: r.status, code: ((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? null }; }, chemin);
const HOTES: Record<string, string> = { notifuse: new URL(APP_URL.notifuse).host, prospection: new URL(APP_URL.prospection).host, analytics: new URL(APP_URL.analytics).host, crm: new URL(APP_URL.twenty).host };

async function clientAvecCrm(browser: Parameters<typeof creerCompteProuve>[0], etiquette: string): Promise<Compte> {
  const c = await creerCompteProuve(browser, etiquette);
  await activerTwentyAuHub(c.email);
  const T = (await lookup(c.email)).json?.tenants?.[0] as { id: string } | undefined;
  if (!T) throw new NonAbouti('compte client sans organisation');
  noterEspaceTwenty(c.email, T.id);
  return { ...c, tenantId: T.id };
}

cas(null, 'entrer chez un client par le lien : chaque app dit vrai, aucun geste au Hub, journal complet', async ({ browser }) => {
  const C = await clientAvecCrm(browser, 'emprclient');
  const etats = (await ouvrir(C.email)).apps;
  expect(etats.map((a) => a.app).sort(), 'les six, toujours').toEqual(['academy', 'analytics', 'crm', 'hub', 'notifuse', 'prospection']);
  expect(etats.filter((a) => !a.entrable && !a.detail), 'une app fermée dit pourquoi').toEqual([]);
  const ouvertes = etats.filter((a) => a.entrable && a.app !== 'hub').map((a) => a.app);
  if (!ouvertes.includes('crm')) throw new Error(`le CRM du client devait être ouvert : ${JSON.stringify(etats)}`);

  // Le Hub.
  const l = await ouvrir(C.email);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  ctx.setDefaultTimeout(45_000);
  try {
    const p = await ctx.newPage();
    await p.goto(l.links.hub as string, { waitUntil: 'networkidle' });
    expect(await session(ctx)).toMatchObject({ email: C.email.toLowerCase(), impersonated: true });
    await expect(p.getByTestId('bandeau-emprunt')).toContainText(C.email);
    await capture(p, 'bandeau');
    const ordinaire = await browser.newContext({ storageState: C.etat as never });
    const po = await ordinaire.newPage();
    await po.goto(`${HUB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    const gestes = ['/api/account/password', '/api/auth/mfa/toggle', '/api/workspace/invite', '/api/billing/checkout', '/api/oauth/authorize', '/api/tenants/start', '/dashboard/ia'];
    const codes = await Promise.all(gestes.map((g) => poster(sabotage === 'emprunt-geste' ? po : p, g)));
    expect(codes, 'tout geste au nom du client').toEqual(gestes.map(() => ({ statut: 403, code: 'impersonation_interdite' })));
    // Témoin : la même demande, de sa propre session, n'est pas arrêtée par ce garde-là.
    expect((await poster(po, '/api/account/password')).code).not.toBe('impersonation_interdite');
    await ordinaire.close();
    await p.goto(`${HUB_URL}/dashboard/admin/clients`, { waitUntil: 'networkidle' });
    expect(new URL(p.url()).pathname, 'pas d\'administration en emprunt').toBe('/dashboard');
    expect((await ctx.request.get(`${HUB_URL}/api/admin/list-tenants`)).status()).toBe(403);
    expect((await ctx.request.get(l.links.hub as string, { maxRedirects: 0 })).headers()['x-impersonate-status'], 'lien déjà servi').toBe('410');
  } finally {
    await ctx.close();
  }

  // Chaque app dite ouverte s'ouvre ; sa ligne est au journal.
  const vus: string[] = [];
  for (const app of ouvertes) {
    const lien = await ouvrir(C.email);
    const x = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const p = await x.newPage();
      await p.goto(lien.links[app] as string, { waitUntil: 'domcontentloaded' });
      await p.waitForURL((u) => (HOTES[app] ? u.host === HOTES[app] || u.host.endsWith(`.${HOTES[app]}`) : u.host !== new URL(HUB_URL).host), { timeout: 60_000 }).catch(() => {});
      await p.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await p.waitForTimeout(3_000);
      expect(new URL(p.url()).host, `${app} : arrivé sur ${p.url().split('?')[0]}`).not.toBe(new URL(HUB_URL).host);
      expect(await p.locator('input[type=password]').count(), `${app} : pas de formulaire de connexion`).toBe(0);
      await capture(p, app);
      vus.push(app);
    } finally {
      await x.close();
    }
    const lignes = duEmprunt(await journal(), sabotage === 'emprunt-journal' ? l.emprunt : lien.emprunt);
    expect(lignes.map((y) => y.action).sort(), `journal de l'entrée dans ${app}`).toEqual(['admin.impersonate.app', 'admin.impersonate.consume', 'admin.impersonate.start']);
    expect(lignes.find((y) => y.action === 'admin.impersonate.start')?.payload).toMatchObject({ par: 'cle:ADMIN_SECRET', raison: 'épreuve système', hubUserId: C.hubUserId });
    expect(lignes.find((y) => y.action === 'admin.impersonate.app')?.payload).toMatchObject({ app, resultat: 'entre' });
  }
  return `entré dans ${vus.join(', ')} ; fermées : ${etats.filter((a) => !a.entrable).map((a) => `${a.app} (${a.etat})`).join(', ') || 'aucune'}`;
}, { timeout: 900_000 });

cas(null, 'entrer chez un client par l\'écran : chercher, entrer, sortir, redevenir soi', async ({ browser }) => {
  if (!STAGING) throw new NonAbouti('épreuve de staging (la liste de prod ne compte que Robert)');
  noter(adresseDe('empradmin'));
  await adminOk('POST', 'users/create', { email: adresseDe('empradmin'), name: 'TEST SYSTEME SSO empradmin', supabaseUserId: ADMIN_EPREUVE });
  const A = await creerCompteProuve(browser, 'empradmin', adresseDe('empradmin'), true);
  expect(A.hubUserId).toBe(ADMIN_EPREUVE);
  const C = await clientAvecCrm(browser, 'emprchez');

  const o = await browser.newContext({ storageState: (sabotage === 'emprunt-ordinaire' ? A : C).etat as never });
  const po = await o.newPage();
  await po.goto(`${HUB_URL}/dashboard/admin/clients?u=${C.hubUserId}`, { waitUntil: 'networkidle' });
  expect(new URL(po.url()).pathname, 'un compte ordinaire n\'y entre pas').toBe('/dashboard');
  expect(await po.getByRole('link', { name: 'Administration' }).count()).toBe(0);
  expect((await poster(po, '/api/admin/emprunt')).statut).toBe(403);
  await o.close();

  const ctx = await browser.newContext({ storageState: A.etat as never, viewport: { width: 1280, height: 900 } });
  ctx.setDefaultTimeout(60_000);
  try {
    const p = await ctx.newPage();
    await p.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' });
    await p.getByRole('link', { name: 'Administration' }).click();
    await p.waitForURL(/\/dashboard\/admin\/clients/);
    await p.getByRole('searchbox').fill(C.email.slice(0, C.email.indexOf('@')));
    await p.getByRole('button', { name: 'Chercher' }).click();
    await p.getByRole('link', { name: new RegExp(C.email) }).click();
    await p.getByTestId('fiche-client').waitFor();
    await capture(p, 'ecran');
    await p.setViewportSize({ width: 390, height: 844 });
    await capture(p, 'ecran-telephone');
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'pas de défilement de côté sur téléphone').toBe(true);
    await p.setViewportSize({ width: 1280, height: 900 });
    await p.getByLabel(/^Raison/).fill('épreuve écran');
    await p.locator('[data-app=hub]').getByRole('button', { name: 'Entrer' }).click();
    await p.getByTestId('bandeau-emprunt').waitFor();
    expect(await session(ctx)).toMatchObject({ email: C.email.toLowerCase(), impersonated: true });
    // Le CRM, depuis la même session empruntée : aucune navigation privée.
    await p.goto(`${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL.twenty}/`)}`, { waitUntil: 'domcontentloaded' });
    await p.waitForURL((u) => u.host !== new URL(HUB_URL).host, { timeout: 60_000 });
    await p.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' });
    if (sabotage === 'emprunt-retour') await ctx.clearCookies({ name: /veridian-retour/ });
    await p.getByRole('button', { name: 'Sortir' }).click();
    await p.waitForURL(/\/dashboard\/admin\/clients\?sortie=/);
    expect(await session(ctx)).toMatchObject({ email: A.email.toLowerCase() });
    expect((await session(ctx))?.impersonated).toBeUndefined();
    await expect(p.getByTestId('sortie-emprunt')).toContainText('CRM, avec mon compte');
    await capture(p, 'sortie');
    const id = new URL(p.url()).searchParams.get('sortie') as string;
    const lignes = duEmprunt(await journal(), id);
    expect(lignes.map((y) => y.action).sort()).toEqual(['admin.impersonate.app', 'admin.impersonate.consume', 'admin.impersonate.end', 'admin.impersonate.start']);
    expect(lignes.find((y) => y.action === 'admin.impersonate.start')?.payload).toMatchObject({ par: ADMIN_EPREUVE, raison: 'épreuve écran', app: 'hub', via: 'ecran' });
    // Sorti : on peut rentrer ; chez soi ou chez l'autre administrateur, non.
    const r = await p.evaluate(async (hubUserId) => { const x = await fetch('/api/admin/emprunt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hubUserId, app: 'hub' }) }); return [x.status, (await x.json()).error]; }, ADMIN_EPREUVE);
    expect(r).toEqual([409, 'soi_meme']);
  } finally {
    await ctx.close();
  }
  return 'cherché, entré, sorti, redevenu soi ; compte ordinaire refusé';
}, { timeout: 600_000 });
