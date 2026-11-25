/**
 * Pré-inscription (VER-227 S1) : une adresse importée AVANT d'avoir un compte rejoint l'organisation à sa première connexion prouvée, arrive dans
 * l'app sans rien choisir, et aucun mail n'est parti. Une adresse non prouvée n'entre pas, une autre adresse non plus, une annulée non plus.
 * Épreuve : `SSO_SABOTAGE=preinscription` annule la pré-inscription avant la connexion : le cas doit échouer.
 */
import { expect } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin, adminOk, lookup, marquerTest } from './lib/hub-admin';
import { adresseDe, attendreSessionHub, connexionHub, creerCompteNonProuve, creerCompteProuve, type Compte } from './lib/parcours';

type Ligne = { email: string; etat: string; role?: string };
type Membres = { document: { membres: { hub_user_id: string; role: string }[] } };

cas(null, 'pré-inscription : importée sans compte, elle rejoint à sa première connexion prouvée et arrive dans l\'app', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('les récepteurs d\'organisation n\'existent qu\'en prod');
  const P: Compte = await creerCompteProuve(browser, 'preprop');
  const T = (await lookup(P.email)).json?.tenants?.[0];
  if (!T) throw new NonAbouti('compte de test sans tenant');
  await marquerTest(T.id);
  const regle = await admin<{ emissions: { app: string; etat: string }[] }>('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: 'TEST préinscription', modules: ['prospection'] });
  expect([regle.status, regle.json.emissions.map((e) => e.etat)], JSON.stringify(regle.json).slice(0, 300)).toEqual([200, ['applique']]);

  // Importées avant d'exister. Rien n'est écrit à blanc ; la seconde fois, l'organisation les attend.
  const adresses = { M: adresseDe('prem'), N: adresseDe('pren'), A: adresseDe('prea') };
  const lignes = Object.values(adresses).map((email) => ({ email: email.toUpperCase() }));
  const blanc = await admin<{ lignes: Ligne[] }>('POST', `organisations/${T.id}/membres`, { membres: lignes, a_blanc: true });
  expect(blanc.json.lignes.map((l) => l.etat)).toEqual(['preinscrit', 'preinscrit', 'preinscrit']);
  expect((await adminOk<{ preinscrits: Ligne[] }>('GET', `organisations/${T.id}/membres`)).preinscrits, 'à blanc : rien').toEqual([]);
  const importe = await admin<{ lignes: Ligne[] }>('POST', `organisations/${T.id}/membres`, { membres: [...lignes, { email: P.email }] });
  expect([importe.status, importe.json.lignes.map((l) => l.etat)], JSON.stringify(importe.json).slice(0, 300)).toEqual([200, ['preinscrit', 'preinscrit', 'preinscrit', 'deja']]);
  await admin('DELETE', `organisations/${T.id}/membres`, { email: adresses.A });
  if (process.env.SSO_SABOTAGE === 'preinscription') await admin('DELETE', `organisations/${T.id}/membres`, { email: adresses.M });

  const M: Compte = await creerCompteProuve(browser, 'prem', adresses.M, true);
  const A: Compte = await creerCompteProuve(browser, 'prea', adresses.A, true);
  const N: Compte = await creerCompteNonProuve(browser, 'pren', adresses.N);
  const X: Compte = await creerCompteProuve(browser, 'prex', undefined, true);
  const entrer = async (c: Compte) => {
    const ctx = await browser.newContext({ storageState: c.etat as never });
    try {
      const page = await ctx.newPage();
      await page.goto(`${APP_URL.prospection}/`, { waitUntil: 'networkidle' });
      return { url: page.url(), texte: await page.locator('body').innerText() };
    } finally {
      await ctx.close();
    }
  };
  // Elle ouvre l'app directement, sans passer par le Hub : elle arrive DANS l'organisation.
  const vue = await entrer(M);
  expect([new URL(vue.url).hostname, vue.texte.includes('TEST préinscription')], `${vue.url} : ${vue.texte.slice(0, 300)}`).toEqual([new URL(APP_URL.prospection).hostname, true]);
  for (const [c, quoi] of [[A, 'annulée'], [N, 'non prouvée'], [X, 'jamais importée']] as const) expect((await entrer(c)).texte, quoi).not.toContain('TEST préinscription');

  const membres = (await adminOk<Membres>('GET', `organisations/${T.id}`)).document.membres;
  expect(membres.map((m) => [m.hub_user_id, m.role]).sort(), 'le propriétaire et M, en membre').toEqual([[P.hubUserId, 'owner'], [M.hubUserId, 'member']].sort());
  const etats = Object.fromEntries((await adminOk<{ preinscrits: Ligne[] }>('GET', `organisations/${T.id}/membres`)).preinscrits.map((p) => [p.email, p.etat]));
  expect([etats[adresses.M.toLowerCase()], etats[adresses.A.toLowerCase()], etats[adresses.N.toLowerCase()]]).toEqual(['joint', 'annulee', 'en_attente']);

  // Le propriétaire lit qui est attendu.
  const ctx = await browser.newContext({ storageState: P.etat as never });
  try {
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/dashboard/organisation`, { waitUntil: 'networkidle' });
    await expect(page.getByText(`${adresses.N.toLowerCase()} : attendue`)).toBeVisible();
    await expect(page.getByText(`${adresses.M.toLowerCase()} : a rejoint`)).toBeVisible();
  } finally {
    await ctx.close();
  }

  // M2, pré-prise de compte : N a été ouvert par quelqu'un qui n'a PAS prouvé l'adresse. Le vrai titulaire la prouve (lien reçu) : il rejoint, et
  // l'ancien accès, session ouverte et mot de passe, est mort.
  if (!N.etat) throw new NonAbouti('le compte non prouvé n\'a pas ouvert de session : M2 ne peut pas être joué');
  const session = async (etat: unknown) => {
    const c = await browser.newContext({ storageState: etat as never });
    try {
      return ((await (await c.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: { email?: string } } | null)?.user?.email ?? null;
    } finally {
      await c.close();
    }
  };
  expect(await session(N.etat), 'contrôle positif : la session d\'avant la preuve vivait').toBe(adresses.N.toLowerCase());
  const vrai: Compte = await creerCompteProuve(browser, 'pren', adresses.N, true);
  expect(await session(N.etat), 'session d\'avant la preuve').toBeNull();
  const ancien = await browser.newContext();
  try {
    const page = await ancien.newPage();
    await connexionHub(page, adresses.N, N.motDePasse);
    expect(await attendreSessionHub(ancien, adresses.N, 12_000), 'mot de passe d\'avant la preuve').toBe(false);
  } finally {
    await ancien.close();
  }
  expect((await entrer(vrai)).texte, 'le vrai titulaire a rejoint').toContain('TEST préinscription');

  // Retirée : elle ne revient pas par la même pré-inscription.
  const retrait = await admin<{ apps: { app: string; etat: string }[] }>('POST', `tenants/${T.id}/remove-member`, { hub_user_id: M.hubUserId });
  expect([200, 207], JSON.stringify(retrait.json).slice(0, 200)).toContain(retrait.status);
  expect((await entrer(M)).texte, 'retirée').not.toContain('TEST préinscription');
  expect((await adminOk<Membres>('GET', `organisations/${T.id}`)).document.membres.map((m) => m.hub_user_id).sort()).toEqual([P.hubUserId, vrai.hubUserId].sort());
  return 'importée sans compte, jointe à la première connexion prouvée, arrivée dans Prospection ; annulée, non prouvée, inconnue : dehors ; retirée : ne revient pas ; M2 : session et mot de passe d\'avant la preuve morts, le vrai titulaire a rejoint';
}, { timeout: 900_000 });
