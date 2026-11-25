/**
 * Changer d'adresse principale (VER-227, AD-M3), sans boîte : la seconde adresse est prouvée par le fournisseur de l'organisation. La personne reste
 * la même dans chaque app (`hub_user_id`, aucun double), l'ancienne adresse n'ouvre plus rien et se détache. Refusés : non prouvée, celle d'un autre,
 * domaine tenu par une AUTRE organisation, rejouée, session ouverte par le fournisseur, compte chez une app qui désigne encore par l'adresse (Mail, CRM).
 * NON PROUVÉ ici : la session trop ancienne (24 h, tests), l'ajout par code reçu (pas de boîte d'épreuve).
 * Épreuves : `SSO_SABOTAGE=promotion` (le fournisseur confirme une autre adresse) et `promotion-ailleurs` (l'organisation qui a prouvé reste la bonne)
 * doivent faire échouer le cas.
 */
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

import { expect, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, appelAcademy, lookup, marquerTest, rybbitCompte, secretDe } from './lib/hub-admin';
import { ouvrirIdp, type IdentiteDite } from './lib/idp-jetable';
import { adresseDe, attendreSessionHub, connexionHub, creerCompteProuve, noter, noterEspaceTwenty, noterRybbit, ouvrirApp, sessionApp, type Compte } from './lib/parcours';

const DOMAINE = 'veridian.site';
const COPIES = { prospection: [APP_URL.prospection, 'PROSPECTION_TENANT_API_SECRET'], analytics: [APP_URL.analytics, 'ANALYTICS_HUB_API_SECRET'], academy: ['https://academy.app.veridian.site', 'ACADEMY_HUB_API_SECRET'] } as const;
type App = keyof typeof COPIES;

cas(null, 'adresse principale : promue si elle est prouvée, la même personne partout', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('le Hub de staging n\'a ni Prospection, ni Analytics, ni Academy en face');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const P: Compte = await creerCompteProuve(browser, 'promp');
  const B: Compte = await creerCompteProuve(browser, 'promb');
  const A: Compte = await creerCompteProuve(browser, 'proma', undefined, true);
  const de = async (c: Compte) => { const t = (await lookup(c.email)).json?.tenants?.[0]; if (!t) throw new NonAbouti('compte de test sans tenant'); await marquerTest(t.id); return t as { id: string; slug: string }; };
  const T = await de(P);
  const T2 = await de(B);
  const A1 = A.email.toLowerCase();
  const [A2, A3, P2] = ['proma2', 'proma3', 'promp2'].map((e) => adresseDe(e).toLowerCase());
  [A2, A3, P2].forEach(noter);

  /** Les comptes d'une app, tels que `hub reconcile` les lit. Secret lu au moment du test, jamais affiché. */
  const copies = async (app: App): Promise<{ hub_user_id: string | null; email: string }[]> => {
    const ts = String(Date.now());
    const sig = createHmac('sha256', secretDe(COPIES[app][1])).update(`${ts}.`).digest('hex');
    const r = await fetch(`${COPIES[app][0]}/api/hub/users`, { headers: { 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': sig }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new NonAbouti(`${app} : lecture des comptes HTTP ${r.status}`);
    return ((await r.json()) as { users: { hub_user_id: string | null; email: string }[] }).users;
  };
  const vue = async (app: App) => { const l = await copies(app); return { elle: l.filter((x) => x.hub_user_id === A.hubUserId).map((x) => x.email.toLowerCase()), parAdresse: l.filter((x) => [A1, A2].includes(x.email.toLowerCase())).length }; };
  const avec = async <R>(etat: unknown, f: (ctx: BrowserContext) => Promise<R>): Promise<R> => {
    const ctx = await browser.newContext(etat ? { storageState: etat as never } : {});
    ctx.setDefaultTimeout(45_000);
    try { return await f(ctx); } finally { await ctx.close(); }
  };
  const geste = (etat: unknown, corps: object) => avec(etat, async (ctx) => { const r = await ctx.request.post(`${HUB_URL}/api/account/adresses`, { data: corps }); return [r.status(), (await r.json().catch(() => null)) as { error?: string; apps?: string[]; url?: string }] as const; });
  const refus = async (etat: unknown, email: string) => { const [s, j] = await geste(etat, { geste: 'promouvoir', email }); return [s, j?.error]; };
  const adresses = (etat: unknown) => avec(etat, async (ctx) => (await (await ctx.request.get(`${HUB_URL}/api/account/adresses`)).json()) as { principale: string; secondaires: string[] });
  const entrer = (email: string, motDePasse: string, ms = 45_000) => avec(null, async (ctx) => { await connexionHub(await ctx.newPage(), email, motDePasse); return (await attendreSessionHub(ctx, email, ms)) ? ctx.storageState() : null; });

  const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
  const idp = await ouvrirIdp(ip);
  const ouvrirPorte = async (tenant: string) => { const r = await admin('PUT', `organisations/${tenant}/idp`, { issuer: idp.issuer, client_id: idp.client.id, client_secret: idp.client.secret, domaines: [DOMAINE] }); expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200); };
  /** Connectée, elle fait confirmer une adresse par son organisation, depuis ses réglages. */
  const prouver = (etat: unknown, email: string, qui: IdentiteDite) => avec(etat, async (ctx) => {
    idp.dire(qui);
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/dashboard/settings`, { waitUntil: 'networkidle' });
    await page.getByLabel('Ajouter une adresse').fill(email);
    await page.getByRole('button', { name: 'Confirmer par mon organisation' }).click();
    await page.waitForURL((u) => u.search.includes('adresse=ajoutee') || u.pathname === '/auth/federation').catch(() => undefined);
    const s = (await (await ctx.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: { email?: string } } | null;
    return { url: page.url(), texte: (await page.locator('body').innerText()).slice(0, 500), session: s?.user?.email?.toLowerCase() ?? null };
  });

  try {
    await adminOk('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: 'TEST promotion', modules: ['prospection'] });
    await ouvrirPorte(T.id);
    expect(await geste(A.etat, { geste: 'federer', email: A2 }), 'pas membre : même réponse qu\'un domaine inconnu').toEqual([404, { error: 'domaine_non_federe' }]);
    expect(await geste(A.etat, { geste: 'federer', email: 'x@inconnu.test' })).toEqual([404, { error: 'domaine_non_federe' }]);
    await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: A.hubUserId });

    // Son compte dans les apps, avant.
    // Chaque adresse qu'elle peut porter, sabotage compris (25/11 : un compte banni restait chez Analytics sous A3).
    [A.email, A2, A3].forEach(noterRybbit);
    rybbitCompte('creer', A.email);
    rybbitCompte('lier', A.email, A.hubUserId ?? undefined);
    await adminOk('POST', 'tenants/app-access', { user_email: P.email, app: 'academy', enabled: true });
    const ac = await appelAcademy(`/api/tenants/${T.id}/sync-member`, { hub_user_id: A.hubUserId, email: A.email, role: 'member', email_proven: true });
    if (!ac.ok) throw new NonAbouti(`entrée à Academy : HTTP ${ac.status}`);
    const dans = (etat: unknown) => avec(etat, async (ctx) => { await ouvrirApp(ctx, 'prospection'); return sessionApp(ctx, 'prospection') as Promise<{ email?: string; id?: string } | null>; });
    const avant = await dans(A.etat);
    if (!avant?.id) throw new NonAbouti('A n\'est pas entrée dans Prospection');
    for (const app of Object.keys(COPIES) as App[]) expect(await vue(app), `${app}, avant`).toEqual({ elle: [A1], parAdresse: 1 });

    // Rien ne se promeut sans preuve, ni celle d'un autre.
    expect(await refus(null, A2), 'sans session').toEqual([401, 'unauthorized']);
    expect(await refus(A.etat, A2), 'jamais prouvée').toEqual([404, 'not_found']);
    expect(await refus(A.etat, B.email), 'celle d\'un autre compte').toEqual([404, 'not_found']);
    const autre = await prouver(A.etat, A2, { sub: 'a-1', email: A3 });
    expect([/confirmé une autre adresse/.test(autre.texte), autre.session], `autre adresse : ${autre.url} ${autre.texte}`).toEqual([true, A1]);
    const deB = await prouver(A.etat, B.email.toLowerCase(), { sub: 'a-1', email: B.email.toLowerCase() });
    expect(/existe déjà/.test(deB.texte), `adresse de B : ${deB.url} ${deB.texte}`).toBe(true);
    expect(await adresses(A.etat)).toMatchObject({ secondaires: [] });

    // Prouvée par le fournisseur : elle reste elle-même, aucune session neuve.
    const p = await prouver(A.etat, A2, { sub: 'a-1', email: sabotage === 'promotion' ? A3 : A2 });
    expect([p.url.includes('adresse=ajoutee'), p.session], `${p.url} ${p.texte}`).toEqual([true, A1]);
    expect(await adresses(A.etat)).toMatchObject({ principale: A.email, secondaires: [A2] });
    expect((await refus(B.etat, A2))[0], 'un autre ne promeut pas la sienne').toBe(404);

    // La session qu'ouvre le fournisseur ne touche pas au compte.
    idp.dire({ sub: 'a-1', email: A2 });
    const relier = (etat: unknown) => avec(etat, async (ctx) => { const page = await ctx.newPage(); await page.goto(`${HUB_URL}/connexion/${T.slug}`, { waitUntil: 'networkidle' }); return { chemin: new URL(page.url()).pathname, etat: await ctx.storageState() }; });
    expect((await relier(null)).chemin, 'adresse secondaire : pas d\'entrée sans l\'avoir relié').toBe('/auth/federation');
    expect((await relier(A.etat)).chemin, 'reliée par sa personne').toBe('/dashboard');
    const federee = await relier(null);
    expect(federee.chemin).toBe('/dashboard');
    expect(await refus(federee.etat, A2), 'session du fournisseur').toEqual([403, 'session_federee']);
    expect((await avec(federee.etat, (ctx) => ctx.request.post(`${HUB_URL}/api/account/password`, { data: { newPassword: 'Nouveau-Passe-9z!' } }))).status(), 'ni son mot de passe').toBe(403);
    expect(await entrer(A1, A.motDePasse), 'contrôle positif : le mot de passe n\'a pas bougé').not.toBeNull();

    // Promue, depuis l'écran.
    await avec(A.etat, async (ctx) => {
      const page = await ctx.newPage();
      await page.goto(`${HUB_URL}/dashboard/settings`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: `Rendre principale ${A2}` }).click();
      await page.waitForURL((u) => u.pathname === '/login');
    });
    expect((await refus(A.etat, A2))[0], 'sa session d\'avant est tombée').toBe(401);
    const neuve = await entrer(A2, A.motDePasse);
    expect(neuve, 'entre avec la nouvelle').not.toBeNull();
    expect(await entrer(A1, A.motDePasse, 12_000), 'l\'ancienne n\'ouvre plus de session').toBeNull();
    const u = (await lookup(A2)).json?.user as { supabase_user_id?: string } | undefined;
    expect(u?.supabase_user_id, 'la même personne au Hub').toBe(A.hubUserId);
    expect(await adresses(neuve)).toMatchObject({ principale: A2, secondaires: [A1] });
    for (const app of Object.keys(COPIES) as App[]) expect(await vue(app), `${app}, après`).toEqual({ elle: [A2], parAdresse: 1 });
    const apres = await dans(neuve);
    expect([apres?.id, apres?.email?.toLowerCase()], 'la même personne dans Prospection').toEqual([avant.id, A2]);
    for (const app of Object.keys(COPIES) as App[]) expect((await vue(app)).parAdresse, `${app} : aucun double après être entrée`).toBe(1);
    expect(await refus(neuve, A2), 'rejouée').toEqual([404, 'not_found']);

    // L'ancienne : pas de compte neuf par le fournisseur, pas d'entrée ; détachée.
    idp.dire({ sub: 'inconnu', email: A1 });
    expect((await relier(null)).chemin, 'l\'ancienne adresse dite par une autre identité').toBe('/auth/federation');

    // Le domaine passe à une AUTRE organisation : ce que la première avait prouvé ne se promeut plus, même pour un membre de la seconde.
    const p3 = await prouver(neuve, A3, { sub: 'a-1', email: A3 });
    expect(p3.url, p3.texte).toContain('adresse=ajoutee');
    // P a un compte chez Mail et au CRM, qui désignent encore par l'adresse : on s'arrête avant, rien ne bouge.
    await activerTwentyAuHub(P.email);
    noterEspaceTwenty(P.email, T.id);
    const pp = await prouver(P.etat, P2, { sub: 'p-1', email: P2 });
    expect(pp.url, pp.texte).toContain('adresse=ajoutee');
    const [s, j] = await geste(P.etat, { geste: 'promouvoir', email: P2 });
    expect([s, j.error, [...(j.apps ?? [])].sort()]).toEqual([409, 'app_par_adresse', ['crm', 'notifuse']]);
    expect((await adresses(P.etat)).principale.toLowerCase(), 'rien n\'a changé').toBe(P.email.toLowerCase());

    if (sabotage !== 'promotion-ailleurs') {
      await adminOk('DELETE', `organisations/${T.id}/idp`);
      expect(await refus(neuve, A3), 'plus personne ne la confirme').toEqual([403, 'preuve_perdue']);
      await ouvrirPorte(T2.id);
      await adminOk('POST', `tenants/${T2.id}/members`, { hub_user_id: A.hubUserId });
    }
    expect(await refus(neuve, A3), 'domaine tenu par une autre organisation').toEqual([403, 'domaine_federe']);
    expect((await geste(neuve, { geste: 'detacher', email: A1 }))[0], 'l\'ancienne se détache').toBe(200);
    expect(await adresses(neuve)).toMatchObject({ principale: A2, secondaires: [A3] });
    return 'prouvée par le fournisseur puis promue à l\'écran ; même hub_user_id au Hub, dans Prospection, Analytics et Academy, aucun double ; ancienne : plus d\'entrée, détachée ; refusés : sans session, non prouvée, d\'un autre, autre adresse que demandée, session du fournisseur, rejouée, preuve perdue, autre organisation, Mail et CRM (encore par adresse)';
  } finally {
    for (const t of [T, T2]) await admin('DELETE', `organisations/${t.id}/idp`).catch(() => undefined);
    await idp.fermer();
  }
}, { timeout: 1_200_000 });
