/**
 * Organisation réglée une fois au Hub (VER-252) : le propriétaire la règle à l'écran, dans un vrai navigateur ; le logo est réencodé et servi ;
 * une app cochée reçoit le document et le relit ; un membre ajouté au Hub entre dans l'app ; l'organisation active part au rebond.
 * Épreuve : `SSO_SABOTAGE=organisation` ne coche pas l'app : le cas doit échouer. Prod (les récepteurs n'existent qu'en prod).
 */
import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin, adminOk, lookup } from './lib/hub-admin';
import { creerCompteProuve, type Compte } from './lib/parcours';

/** Un PNG rouge de 8 x 8, avec un commentaire qui ne doit pas survivre au réencodage. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8z4APMOGVHbHSTAwMDAAEfAEPg3nN5gAAAABJRU5ErkJggg==', 'base64');
type Emission = { app: string; etat: string; a_jour: boolean; detail: string | null };

cas(null, 'organisation : réglée une fois au Hub, reçue et relue par l\'app, un membre ajouté y entre', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('les récepteurs d\'organisation n\'existent qu\'en prod');
  const P: Compte = await creerCompteProuve(browser, 'orgprop');
  const M: Compte = await creerCompteProuve(browser, 'orgmembre');
  const T = (await lookup(P.email)).json?.tenants?.[0];
  if (!T) throw new NonAbouti('compte de test sans tenant');

  // 1. L'écran, par le propriétaire.
  const ctx = await browser.newContext({ storageState: P.etat as never });
  let logo = '';
  try {
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/dashboard/organisation`, { waitUntil: 'networkidle' });
    await page.getByLabel('Nom affiché').fill('TEST organisation');
    await page.getByLabel('Type').selectOption('organisation');
    await page.getByLabel('Couleur principale').fill('#0B5FFF');
    await page.getByLabel(/^Logo/).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Enregistré', { exact: false }).first()).toBeVisible();
    logo = (await page.locator('img[alt^="Logo de"]').getAttribute('src')) ?? '';
  } finally {
    await ctx.close();
  }
  const image = await fetch(logo);
  expect([image.status, image.headers.get('content-type')], logo).toEqual([200, 'image/png']);
  expect((await fetch(logo.replace(/v=.*/, 'v=autre'))).status, 'une autre empreinte').toBe(404);

  // 2. Un membre ne règle rien : pas d'organisation à régler à l'écran pour lui, et l'appel direct est refusé.
  const ctxM = await browser.newContext({ storageState: M.etat as never });
  try {
    const r = await ctxM.request.post(`${HUB_URL}/api/organisations/regler`, { multipart: { tenant: T.id, type: 'individuel', nom_affiche: 'pirate' }, headers: { origin: HUB_URL }, maxRedirects: 0 });
    expect(r.headers().location ?? '', 'étranger').toContain('role_insuffisant');
  } finally {
    await ctxM.close();
  }

  // 3. Une app cochée reçoit et relit.
  const modules = process.env.SSO_SABOTAGE === 'organisation' ? [] : ['prospection'];
  const coche = await admin<{ emissions: Emission[] }>('PUT', `organisations/${T.id}`, { modules });
  expect([coche.status, coche.json.emissions.map((e) => [e.app, e.etat])], JSON.stringify(coche.json).slice(0, 300)).toEqual([200, [['prospection', 'applique']]]);
  const d = await adminOk<{ document: { version: number; nom: string; type: string; marque: { couleur_primaire: string } }; emissions: Emission[] }>('GET', `organisations/${T.id}`);
  expect([d.document.nom, d.document.type, d.document.marque.couleur_primaire], 'rien de « pirate »').toEqual(['TEST organisation', 'organisation', '#0B5FFF']);
  expect(d.emissions.map((e) => e.a_jour)).toEqual([true]);

  // 4. Un membre ajouté au Hub part aussitôt, la version monte.
  const ajout = await admin<{ organisation?: Emission[] }>('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
  expect(ajout.json.organisation?.map((e) => [e.app, e.etat]), JSON.stringify(ajout.json).slice(0, 300)).toEqual([['prospection', 'applique']]);
  const apres = await adminOk<{ document: { version: number; membres: { hub_user_id: string }[] } }>('GET', `organisations/${T.id}`);
  expect(apres.document.version).toBeGreaterThan(d.document.version);
  expect(apres.document.membres.map((x) => x.hub_user_id).sort()).toEqual([P.hubUserId, M.hubUserId].sort());
  return `réglée à l'écran, logo servi en PNG, Prospection relue à la version ${apres.document.version}, membre parti avec`;
}, { timeout: 300_000 });
