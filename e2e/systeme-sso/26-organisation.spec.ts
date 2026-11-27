/**
 * Organisation réglée une fois au Hub (VER-252) : le propriétaire la règle à l'écran, dans un vrai navigateur ; le logo est réencodé et servi ;
 * une app cochée reçoit le document et le relit ; un membre ajouté au Hub entre dans l'app ; l'organisation active part au rebond.
 * Épreuve : `SSO_SABOTAGE=organisation` ne coche pas l'app : le cas doit échouer. Prod (les récepteurs n'existent qu'en prod).
 */
import { crc32, deflateSync } from 'node:zlib';

import { expect } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, lookup } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, noterEspaceTwenty, ouvrirApp, type Compte } from './lib/parcours';

/** Un PNG rouge de 8 x 8 fabriqué ici (une image en base64 ressemble à un secret), avec un commentaire qui ne doit pas survivre au réencodage. */
const bloc = (type: string, d: Buffer) => {
  const corps = Buffer.concat([Buffer.from(type, 'latin1'), d]);
  const n = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  return Buffer.concat([n(d.length), corps, n(crc32(corps))]);
};
const ligne = Buffer.concat([Buffer.from([0]), Buffer.alloc(24, Buffer.from([208, 16, 16]))]);
const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  bloc('IHDR', Buffer.from([0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0])),
  bloc('tEXt', Buffer.from('Comment\0COMMENTAIRE-A-PERDRE', 'latin1')),
  bloc('IDAT', deflateSync(Buffer.concat(Array(8).fill(ligne)))),
  bloc('IEND', Buffer.alloc(0)),
]);
type Emission = { app: string; etat: string; a_jour: boolean; detail: string | null };

cas(null, 'organisation : réglée une fois au Hub, reçue et relue par l\'app, un membre ajouté y entre', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('les récepteurs d\'organisation n\'existent qu\'en prod');
  const P: Compte = await creerCompteProuve(browser, 'orgprop');
  const M: Compte = await creerCompteProuve(browser, 'orgmembre');
  const T = (await lookup(P.email)).json?.tenants?.[0];
  if (!T) throw new NonAbouti('compte de test sans tenant');
  // L'espace CRM du propriétaire : le récepteur du CRM ne crée rien, il règle un espace ouvert (VER-252).
  await activerTwentyAuHub(P.email);
  noterEspaceTwenty(P.email, T.id);

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
    await page.waitForURL(/avis=/);
    expect(new URL(page.url()).searchParams.get('avis'), 'avis rendu par l\'écran').toBe('enregistre');
    await expect(page.getByText('Enregistré', { exact: false }).first()).toBeVisible();
    // Le menu montre aussi le logo de l'organisation : on lit celui de l'écran.
    logo = (await page.getByRole('main').locator('img[alt^="Logo de"]').first().getAttribute('src')) ?? '';
  } finally {
    await ctx.close();
  }
  const image = await fetch(logo);
  expect([image.status, image.headers.get('content-type')], logo).toEqual([200, 'image/png']);
  expect(PNG.includes('COMMENTAIRE-A-PERDRE'), 'le PNG déposé porte le commentaire').toBe(true);
  expect(Buffer.from(await image.arrayBuffer()).includes('COMMENTAIRE-A-PERDRE'), 'réencodé : le commentaire est perdu').toBe(false);
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
  const modules = process.env.SSO_SABOTAGE === 'organisation' ? [] : ['prospection', 'crm'];
  const coche = await admin<{ emissions: Emission[] }>('PUT', `organisations/${T.id}`, { modules });
  expect([coche.status, coche.json.emissions.map((e) => [e.app, e.etat])], JSON.stringify(coche.json).slice(0, 300)).toEqual([200, [['prospection', 'applique'], ['crm', 'applique']]]);
  const d = await adminOk<{ document: { version: number; nom: string; type: string; marque: { couleur_primaire: string } }; emissions: Emission[] }>('GET', `organisations/${T.id}`);
  expect([d.document.nom, d.document.type, d.document.marque.couleur_primaire], 'rien de « pirate »').toEqual(['TEST organisation', 'organisation', '#0B5FFF']);
  expect(d.emissions.map((e) => [e.app, e.a_jour]).sort(), 'chaque app sert la version du Hub, logo compris').toEqual([['crm', true], ['prospection', true]]);

  // 4. Un membre ajouté au Hub part aussitôt, la version monte.
  const ajout = await admin<{ organisation?: Emission[] }>('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
  expect(ajout.json.organisation?.map((e) => [e.app, e.etat]), JSON.stringify(ajout.json).slice(0, 300)).toEqual([['prospection', 'applique'], ['crm', 'applique']]);
  const apres = await adminOk<{ document: { version: number; membres: { hub_user_id: string }[] } }>('GET', `organisations/${T.id}`);
  expect(apres.document.version).toBeGreaterThan(d.document.version);
  expect(apres.document.membres.map((x) => x.hub_user_id).sort()).toEqual([P.hubUserId, M.hubUserId].sort());
  // Le membre ajouté est dans l'espace CRM, vu par LUI, par la porte MCP ; il y voit le propriétaire.
  // Le membre n'a JAMAIS été activé au CRM : c'est l'organisation, qui l'a coché, qui le lui ouvre (option A).
  const jetonM = await obtenirJetonMcp(browser, M, 'TEST ORGANISATION');
  const vusCrm = (await outil(jetonM, 'executer_outil', { nom: 'twenty.api_lire', arguments: { query: 'query { workspaceMembers(first: 10) { edges { node { id userEmail } } } }' }, espace: T.slug })).texte;
  expect([vusCrm.includes(M.email.toLowerCase()), vusCrm.includes(P.email.toLowerCase())], `${vusCrm.slice(0, 200)} ; outils : ${(await outil(jetonM, 'chercher_outils', { besoin: 'lire les sociétés', app: 'twenty' })).texte.slice(0, 500)}`).toEqual([true, true]);

  // 5. Le membre, qui a aussi son propre espace, choisit l'organisation au Hub et arrive DEDANS dans l'app. La preuve d'arrivée : le cookie
  // d'espace que l'app pose (veridian-espace), différent avec et sans le choix.
  const ctxA = await browser.newContext({ storageState: M.etat as never });
  const arrivee = async () => {
    const page = await ctxA.newPage();
    await page.goto(`${APP_URL.prospection}/`, { waitUntil: 'networkidle' });
    const c = (await ctxA.cookies(APP_URL.prospection)).find((x) => x.name === 'veridian-espace')?.value ?? null;
    const texte = await page.locator('body').innerText();
    await page.close();
    return { c, dedans: texte.includes('TEST organisation') };
  };
  let sans: Awaited<ReturnType<typeof arrivee>>;
  let avec: Awaited<ReturnType<typeof arrivee>>;
  try {
    sans = await arrivee();
    const page = await ctxA.newPage();
    await page.goto(`${HUB_URL}/dashboard/organisation`, { waitUntil: 'networkidle' });
    await page.getByLabel('Organisation active').selectOption(T.id);
    await page.getByRole('button', { name: 'Choisir' }).click();
    // Pendant la transition qui suit le formulaire, l'ancienne et la nouvelle page coexistent un instant : on attend le message affiché (26/11).
    await expect(page.getByRole('status').filter({ hasText: 'Organisation active changée' }).last()).toBeVisible();
    await page.close();
    // Nouvelle entrée : la session d'app est retirée, le rebond repart du Hub.
    await ctxA.clearCookies({ domain: new URL(APP_URL.prospection).hostname });
    avec = await arrivee();
  } finally {
    await ctxA.close();
  }
  expect(avec.c, `espace d'arrivée sans choix ${sans.c}, avec choix ${avec.c}, nom affiché ${avec.dedans}`).not.toBe(sans.c);
  // Le logo et le nom tels que le CRM les sert, sans session (CRM, 25/11).
  const ctxCrm = await browser.newContext({ storageState: P.etat as never });
  const hoteCrm = await ouvrirApp(ctxCrm, 'twenty').then((x) => new URL(x.url).origin).finally(() => ctxCrm.close());
  const pub = (await (await fetch(`${hoteCrm}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: hoteCrm }, body: JSON.stringify({ query: 'query($o:String!){getPublicWorkspaceDataByDomain(origin:$o){displayName logo}}', variables: { o: hoteCrm } }) })).json().catch(() => null)) as { data?: { getPublicWorkspaceDataByDomain?: { displayName?: string; logo?: string } } } | null;
  const espaceCrm = pub?.data?.getPublicWorkspaceDataByDomain;
  expect([espaceCrm?.displayName, Boolean(espaceCrm?.logo)], JSON.stringify(pub).slice(0, 300)).toEqual(['TEST organisation', true]);
  const logoCrm = await fetch(new URL(espaceCrm!.logo!, hoteCrm));
  expect([logoCrm.status, logoCrm.headers.get('content-type')], espaceCrm!.logo!.slice(0, 120)).toEqual([200, 'image/png']);

  // Suspendue, reprise, puis retiré : fermé au Hub (porte MCP, rebond, jetons) ET dans le CRM (VER-254). La session et la clé : cas 34.
  const appsDeM = async () => (JSON.parse((await outil(jetonM, 'chercher_outils', { besoin: 'lire les sociétés', app: 'twenty' })).texte) as { apps: string[] }).apps.includes('twenty');
  expect(await appsDeM(), 'contrôle positif').toBe(true);
  const crm = async (suspendre: boolean) => (await admin<{ apps: { app: string; etat: string }[] }>('POST', `tenants/${T.id}/suspension`, { suspendre, motif: 'TEST' })).json.apps?.find((x) => x.app === 'crm')?.etat;
  expect(await crm(true), 'fermé dans le CRM').toBe('suspendu');
  expect(await appsDeM(), 'suspendue : fermé au Hub').toBe(false);
  expect(await crm(false), 'rouvert dans le CRM').toBe('repris');
  expect(await appsDeM(), 'reprise').toBe(true);
  await admin('POST', `tenants/${T.id}/remove-member`, { hub_user_id: M.hubUserId });
  expect(await appsDeM(), 'retiré').toBe(false);
  return `réglée à l'écran, logo servi en PNG, Prospection et CRM relus à la version ${apres.document.version}, membre parti avec, arrivée dans l'organisation choisie (nom affiché : ${avec.dedans}) ; nom et logo servis par le CRM ; CRM ouvert au membre par l'organisation, refermé au Hub et dans le CRM suspendue, au Hub retiré`;
}, { timeout: 480_000 });
