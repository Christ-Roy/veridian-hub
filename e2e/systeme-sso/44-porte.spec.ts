/**
 * La porte d'une organisation (VER-261, ASD) : alias lisible, retenue par le navigateur, départ seul une fois et jamais en boucle, sortie visible ; session de
 * sept jours, coupée à la lecture suivante par un retrait ou un fournisseur retiré ; compte inconnu : première entrée, même réponse à toute adresse.
 * Fournisseur réglé comme Infomaniak (RS256, aucune adresse crue), organisation de test. NON PROUVÉ : le vrai Infomaniak ; le code lu dans une vraie boîte ;
 * six jours d'âge réel (tests : duree et borne).
 * Épreuves : `SSO_SABOTAGE=porte-boucle` ôte la pause ; `porte-retrait` ne retire pas : le cas doit échouer.
 */
import { execFileSync } from 'node:child_process';

import { expect, type BrowserContext, type Page } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin, adminOk, lookup, marquerTest } from './lib/hub-admin';
import { ouvrirIdp } from './lib/idp-jetable';
import { creerCompteProuve, ID_RUN, type Compte } from './lib/parcours';

const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

cas(null, 'porte d\'organisation : retenue, part seule une fois, se quitte ; session de 7 jours coupée au retrait', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (organisations réglées)');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const P: Compte = await creerCompteProuve(browser, 'porteprop');
  const M: Compte = await creerCompteProuve(browser, 'portemem', undefined, true);
  const T = (await lookup(P.email)).json?.tenants?.[0] as { id: string; slug: string } | undefined;
  if (!T) throw new NonAbouti('compte de test sans organisation');
  await marquerTest(T.id);
  await adminOk('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: 'TEST PORTE', modules: ['prospection'] });
  await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
  const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
  const idp = await ouvrirIdp(ip, 'RS256');
  const alias = `e2e-${ID_RUN}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  const ouverts: BrowserContext[] = [];
  const ctxDe = async (c?: Compte) => { const x = await browser.newContext({ ...(c ? { storageState: c.etat as never } : {}), viewport: { width: 1280, height: 900 } }); x.setDefaultTimeout(45_000); ouverts.push(x); return x; };
  const session = async (c: BrowserContext) => ((await (await c.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: { email?: string; federe?: boolean } } | null)?.user ?? null;
  const oublier = (c: BrowserContext, nom: RegExp) => c.clearCookies({ name: nom });
  const poser = () => adminOk('PUT', `organisations/${T.id}/idp`, { issuer: idp.issuer, client_id: idp.client.id, client_secret: idp.client.secret, domaines: [], alias, session_jours: 7 });
  try {
    await poser();
    // Compte inconnu : première entrée, la même réponse à une adresse attendue et à une autre, aucun code deviné.
    idp.dire({ sub: 'inconnu-1', email: 'perso@gmail.com', email_verified: true });
    const neuf = await ctxDe();
    const pn: Page = await neuf.newPage();
    await pn.goto(`${HUB_URL}/connexion/${alias}`, { waitUntil: 'networkidle' });
    expect([new URL(pn.url()).pathname, /pas encore relié/.test(await pn.locator('body').innerText())], pn.url()).toEqual(['/auth/premiere-entree', true]);
    const reponses: string[] = [];
    for (const adresse of [M.email, `e2e-sso-${ID_RUN}-personne@veridian.site`]) {
      await pn.goto(`${HUB_URL}/auth/premiere-entree`, { waitUntil: 'networkidle' });
      await pn.getByLabel('Adresse').fill(adresse);
      await pn.getByRole('button', { name: 'Recevoir le code' }).click();
      await pn.getByLabel('Code reçu').waitFor();
      reponses.push(await pn.locator('form').first().innerText());
      await pn.getByLabel('Code reçu').fill('000000');
      await pn.getByRole('button', { name: 'Entrer' }).click();
      await pn.getByText('Code incorrect ou expiré').waitFor();
    }
    expect(reponses[0], 'rien ne dit qui est attendu').toBe(reponses[1]);
    expect(await session(neuf)).toBeNull();

    // Elle relie le sien, entre par l'alias ; ce navigateur retient la porte, et rien d'autre.
    const mem = await ctxDe(M);
    const pm = await mem.newPage();
    idp.dire({ sub: '1741079', email: 'perso@gmail.com', email_verified: false });
    await pm.goto(`${HUB_URL}/dashboard/settings`, { waitUntil: 'networkidle' });
    await pm.getByRole('button', { name: /^Relier mon compte/ }).click({ timeout: 20_000 });
    await pm.waitForURL(/federation=reliee/);
    const c = await ctxDe();
    const p = await c.newPage();
    const entrer = async () => { await p.goto(`${HUB_URL}/connexion/${alias}`, { waitUntil: 'networkidle' }); return new URL(p.url()).pathname; };
    expect([await entrer(), (await session(c))?.email?.toLowerCase(), (await session(c))?.federe]).toEqual(['/dashboard', M.email.toLowerCase(), true]);
    const porte = (await c.cookies(HUB_URL)).find((x) => x.name === 'veridian-porte');
    expect([porte?.value, porte?.httpOnly, porte?.secure], 'le nom seul').toEqual([alias, true, true]);
    const n = idp.demandes();
    expect([await entrer(), idp.demandes()], 'déjà entrée : pas de nouveau consentement').toEqual(['/dashboard', n]);

    // Session finie : la page part seule, une fois, et la ramène.
    // La page ouverte réécrit le cookie de session à chaque requête : on la quitte d'abord, sinon elle le ressuscite (22:38, deux passages faux).
    const finir = async () => {
      await p.goto('about:blank');
      await pause(1_500);
      await oublier(c, /session-token/);
      if (await session(c)) throw new NonAbouti('la session d\'épreuve ne s\'est pas oubliée');
    };
    await finir();
    await oublier(c, /porte-pause/);
    await p.goto(`${HUB_URL}/login`, { waitUntil: 'networkidle' });
    expect(await p.getByText('Départ dans').count(), 'annoncé, avec sa sortie').toBe(1);
    await p.waitForURL(/\/dashboard/, { timeout: 30_000 });
    expect((await session(c))?.email?.toLowerCase(), 'ramenée sans rien taper').toBe(M.email.toLowerCase());
    // Aussitôt après : jamais deux fois de suite.
    await finir();
    const avant = idp.demandes();
    if (sabotage === 'porte-boucle') await oublier(c, /porte-pause/);
    await p.goto(`${HUB_URL}/login`, { waitUntil: 'networkidle' });
    await pause(7_000);
    expect([new URL(p.url()).pathname, idp.demandes() - avant, await p.getByRole('link', { name: /^Continuer avec/ }).count(), await session(c)], 'pas de boucle').toEqual(['/login', 0, 1, null]);
    // La sortie visible arrête le départ ; la connexion habituelle est là.
    await oublier(c, /porte-pause/);
    await p.goto(`${HUB_URL}/login`, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Me connecter autrement' }).click();
    await pause(6_000);
    expect([new URL(p.url()).pathname, await p.locator('input[type=password]').count()], 'sortie visible').toEqual(['/login', 1]);
    // Déconnexion voulue : elle n'est pas ramenée.
    expect(await entrer()).toBe('/dashboard');
    const csrf = ((await (await c.request.get(`${HUB_URL}/api/auth/csrf`)).json()) as { csrfToken: string }).csrfToken;
    await oublier(c, /porte-pause/);
    await c.request.post(`${HUB_URL}/api/auth/signout`, { form: { csrfToken: csrf, callbackUrl: HUB_URL } });
    expect(await session(c), 'déconnectée').toBeNull();
    await p.goto(`${HUB_URL}/login`, { waitUntil: 'networkidle' });
    await pause(6_000);
    expect(new URL(p.url()).pathname, 'déconnectée, pas ramenée').toBe('/login');

    // Retirée : la session de sept jours tombe à la lecture suivante ; elle ne rentre pas.
    expect(await entrer()).toBe('/dashboard');
    const t0 = Date.now();
    if (sabotage !== 'porte-retrait') await adminOk('POST', `tenants/${T.id}/remove-member`, { hub_user_id: M.hubUserId });
    let tombee = -1;
    for (let k = 0; k < 10 && tombee < 0; k++) { if (!(await session(c))) tombee = Date.now() - t0; else await pause(500); }
    expect(tombee, 'retirée : la session tombe').toBeGreaterThanOrEqual(0);
    expect(await entrer(), 'retirée : ne rentre pas').toBe('/auth/federation');
    // Remise, entrée, puis fournisseur retiré : ce qu'il avait ouvert tombe, et la porte ne se propose plus.
    await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
    expect(await entrer()).toBe('/dashboard');
    await adminOk('DELETE', `organisations/${T.id}/idp`);
    expect(await session(c), 'fournisseur retiré').toBeNull();
    await p.goto(`${HUB_URL}/login`, { waitUntil: 'networkidle' });
    expect(await p.getByRole('link', { name: /^Continuer avec/ }).count(), 'porte fermée').toBe(0);
    return `retrait : session tombée en ${tombee} ms ; retenue, ramenée une fois sans rien taper, sans boucle, sortie visible ; inconnue : première entrée, rien de dit`;
  } finally {
    await admin('DELETE', `organisations/${T.id}/idp`).catch(() => undefined);
    await idp.fermer();
    for (const x of ouverts) await x.close().catch(() => undefined);
  }
}, { timeout: 900_000 });
