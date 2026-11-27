/**
 * Changer d'adresse principale (VER-227, AD-M3), sans boîte : la seconde adresse est prouvée par le fournisseur de l'organisation. La personne reste
 * la même dans chaque app (`hub_user_id`, aucun double), l'ancienne adresse n'ouvre plus rien et se détache. Refusés : non prouvée, celle d'un autre,
 * domaine tenu par une AUTRE organisation, rejouée, session ouverte par le fournisseur, compte chez Academy, qui désigne encore par l'adresse. Le lien
 * direct de Mail ouvre la même personne avant et après.
 * NON PROUVÉ ici : la session trop ancienne (24 h, tests), l'ajout par code reçu (pas de boîte d'épreuve).
 * Épreuves : `SSO_SABOTAGE=promotion` (le fournisseur confirme une autre adresse) et `promotion-ailleurs` (l'organisation qui a prouvé reste la bonne)
 * doivent faire échouer le cas.
 */
import { execFileSync } from 'node:child_process';

import { expect, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, appelAcademy, lookup, marquerTest, rybbitCompte, secretDe } from './lib/hub-admin';
import { ouvrirIdp, type IdentiteDite } from './lib/idp-jetable';
import { adresseDe, attendreSessionHub, connexionHub, creerCompteProuve, noter, noterEspaceTwenty, noterRybbit, ouvrirApp, sessionApp, type Compte } from './lib/parcours';
import { signatureVersApp } from './lib/signature-app';

const DOMAINE = 'veridian.site';
const COPIES = { notifuse: [APP_URL.notifuse, 'NOTIFUSE_HUB_API_SECRET'], crm: [APP_URL.twenty, 'CRM_HUB_API_SECRET_PROD'], prospection: [APP_URL.prospection, 'PROSPECTION_TENANT_API_SECRET'], analytics: [APP_URL.analytics, 'ANALYTICS_HUB_API_SECRET'] } as const;
type App = keyof typeof COPIES;

cas(null, 'adresse principale : promue si elle est prouvée, la même personne partout', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('le Hub de staging n\'a ni Prospection, ni Analytics, ni Academy en face');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const P: Compte = await creerCompteProuve(browser, 'pprom');
  const B: Compte = await creerCompteProuve(browser, 'bprom');
  // Étiquettes distinctes dès la 1re lettre : l'id d'espace Mail est le début de l'adresse coupé à 20 caractères, deux comptes s'y confondraient (25/11).
  // A a son propre espace Mail et Prospection ; elle entre au CRM par l'organisation T.
  const A: Compte = await creerCompteProuve(browser, 'aprom');
  const de = async (c: Compte) => { const t = (await lookup(c.email)).json?.tenants?.[0]; if (!t) throw new NonAbouti('compte de test sans tenant'); await marquerTest(t.id); return t as { id: string; slug: string }; };
  const T = await de(P);
  const T2 = await de(B);
  const A1 = A.email.toLowerCase();
  const [A2, A3, P2] = ['aprom2', 'aprom3', 'pprom2'].map((e) => adresseDe(e).toLowerCase());
  [A2, A3, P2].forEach(noter);

  /** Les comptes d'une app, tels que `hub reconcile` les lit. Secret lu au moment du test, jamais affiché. */
  const copies = async (app: App): Promise<{ hub_user_id: string | null; email: string }[]> => {
    const url = `${COPIES[app][0]}/api/hub/users`;
    const r = await fetch(url, { headers: signatureVersApp(app, secretDe(COPIES[app][1]), 'GET', url), signal: AbortSignal.timeout(30_000) });
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
    await activerTwentyAuHub(P.email);
    noterEspaceTwenty(P.email, T.id);
    await adminOk('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: 'TEST promotion', modules: ['prospection', 'crm'] });
    await ouvrirPorte(T.id);
    expect(await geste(A.etat, { geste: 'federer', email: A2 }), 'pas membre : même réponse qu\'un domaine inconnu').toEqual([404, { error: 'domaine_non_federe' }]);
    expect(await geste(A.etat, { geste: 'federer', email: 'x@inconnu.test' })).toEqual([404, { error: 'domaine_non_federe' }]);
    await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: A.hubUserId });

    // Son compte dans les apps, avant.
    // Chaque adresse qu'elle peut porter, sabotage compris (25/11 : un compte banni restait chez Analytics sous A3).
    [A.email, A2, A3].forEach(noterRybbit);
    rybbitCompte('creer', A.email);
    rybbitCompte('lier', A.email, A.hubUserId ?? undefined);
    /** Le bouton « ouvrir Mail » : le rebond signé du Hub (/login?next=), et qui s'y retrouve vraiment. */
    const ouvrirMail = async (etat: unknown) => {
      return avec(etat, async (ctx) => {
        const r = await ctx.request.post(`${HUB_URL}/api/admin/notifuse/magic-link`, { data: { tenantId: A.tenantId } });
        const statut = r.status();
        const { url } = (await r.json().catch(() => ({}))) as { url?: string };
        if (!url) return { statut, source: null, id: null, email: null };
        const page = await ctx.newPage();
        await page.goto(new URL(url, HUB_URL).toString(), { waitUntil: 'networkidle' });
        await page.waitForFunction(() => Boolean(localStorage.getItem('auth_token')));
        const moi = await page.evaluate(async () => (await (await fetch('/api/user.me', { headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` } })).json()) as { user?: { id?: string; email?: string } });
        return { statut, source: 'rebond', id: moi.user?.id ?? null, email: moi.user?.email?.toLowerCase() ?? null };
      });
    };
    const dansCrm = (etat: unknown) => avec(etat, async (ctx) => {
      const a = await ouvrirApp(ctx, 'twenty');
      const o = new URL(a.url).origin;
      const r = await ctx.request.post(`${o}/metadata`, { headers: { origin: o, 'x-twenty-session-cookie': '1' }, data: { query: '{currentUser{id email}}' } });
      const u = ((await r.json().catch(() => null)) as { data?: { currentUser?: { id: string; email: string } } } | null)?.data?.currentUser;
      return { id: u?.id ?? null, email: u?.email?.toLowerCase() ?? null };
    });
    const dans = (etat: unknown) => avec(etat, async (ctx) => { await ouvrirApp(ctx, 'prospection'); return sessionApp(ctx, 'prospection') as Promise<{ email?: string; id?: string } | null>; });
    const avant = await dans(A.etat);
    if (!avant?.id) throw new NonAbouti('A n\'est pas entrée dans Prospection');
    const mailAvant = await ouvrirMail(A.etat);
    const crmAvant = await dansCrm(A.etat);
    expect([mailAvant.statut, mailAvant.email, crmAvant.email], `ouvrir Mail ${JSON.stringify(mailAvant)}`).toEqual([200, A1, A1]);
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

    idp.dire({ sub: 'a-1', email: A2 });
    const relier = (etat: unknown) => avec(etat, async (ctx) => {
      const page = await ctx.newPage();
      await page.goto(`${HUB_URL}/connexion/${T.slug}`, { waitUntil: 'networkidle' });
      const s = (await (await ctx.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: { email?: string; federe?: boolean } } | null;
      return { chemin: new URL(page.url()).pathname, etat: await ctx.storageState(), federe: s?.user?.federe === true, email: s?.user?.email ?? null };
    });
    expect((await relier(null)).chemin, 'adresse secondaire : pas d\'entrée sans l\'avoir relié').toBe('/auth/federation');
    // A, déjà connectée par son mot de passe et membre : depuis VER-261 (30a86c1, route /connexion), sa session RESTE la sienne et gagne
    // l'organisation ; ce n'est pas une session fédérée, la borne de §5.19.6 ne s'y applique pas. La faille serait une session FÉDÉRÉE
    // ouverte pour une personne qui appartient aussi ailleurs : c'est ce qui est vérifié (cas 39 : ses gestes fédérés refusés).
    const deA = await relier(A.etat);
    expect([deA.chemin, deA.federe, deA.email], 'reliée par sa propre session : elle reste la sienne, jamais fédérée').toEqual(['/dashboard', false, A1]);
    expect((await relier(null)).chemin).toBe('/auth/federation');
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
    const mailApres = await ouvrirMail(neuve);
    expect([mailApres.statut, mailApres.source, mailApres.id, mailApres.email], 'ouvrir Mail : la même personne').toEqual([200, mailAvant.source, mailAvant.id, A2]);
    expect(await dansCrm(neuve), 'la même personne au CRM').toEqual({ id: crmAvant.id, email: A2 });
    for (const app of Object.keys(COPIES) as App[]) expect((await vue(app)).parAdresse, `${app} : aucun double après être entrée`).toBe(1);
    expect(await refus(neuve, A2), 'rejouée').toEqual([404, 'not_found']);

    // L'ancienne : pas de compte neuf par le fournisseur, pas d'entrée ; détachée.
    idp.dire({ sub: 'inconnu', email: A1 });
    expect((await relier(null)).chemin, 'l\'ancienne adresse dite par une autre identité').toBe('/auth/federation');

    // Le domaine passe à une AUTRE organisation : ce que la première avait prouvé ne se promeut plus, même pour un membre de la seconde.
    const p3 = await prouver(neuve, A3, { sub: 'a-1', email: A3 });
    expect(p3.url, p3.texte).toContain('adresse=ajoutee');
    // Academy rattache les inscriptions (des preuves de formation) par l'adresse : y entrer ferme la promotion.
    await adminOk('POST', 'tenants/app-access', { user_email: P.email, app: 'academy', enabled: true });
    const ac = await appelAcademy(`/api/tenants/${T.id}/sync-member`, { hub_user_id: A.hubUserId, email: A2, role: 'member', email_proven: true });
    if (!ac.ok) throw new NonAbouti(`entrée à Academy : HTTP ${ac.status}`);
    expect((await geste(neuve, { geste: 'promouvoir', email: A3 })).map((x) => (typeof x === 'number' ? x : [x?.error, x?.apps])), 'Academy').toEqual([409, ['app_par_adresse', ['academy']]]);
    // P a un compte chez Mail, au CRM et chez Academy : Academy seule, qui désigne encore par l'adresse, l'arrête, et rien ne bouge.
    const pp = await prouver(P.etat, P2, { sub: 'p-1', email: P2 });
    expect(pp.url, pp.texte).toContain('adresse=ajoutee');
    const [s, j] = await geste(P.etat, { geste: 'promouvoir', email: P2 });
    expect([s, j.error, [...(j.apps ?? [])].sort()]).toEqual([409, 'app_par_adresse', ['academy']]);
    expect((await adresses(P.etat)).principale.toLowerCase(), 'rien n\'a changé').toBe(P.email.toLowerCase());

    if (sabotage !== 'promotion-ailleurs') {
      await adminOk('DELETE', `organisations/${T.id}/idp`);
      expect(await refus(neuve, A3), 'plus personne ne la confirme').toEqual([403, 'preuve_perdue']);
      await ouvrirPorte(T2.id);
      await adminOk('POST', `tenants/${T2.id}/members`, { hub_user_id: A.hubUserId });
    }
    expect(await refus(neuve, A3), 'domaine tenu par une autre organisation').toEqual([403, 'domaine_federe']);
    // L'ancienne a été prévenue et peut annuler 72 h (AD-M3) : pendant ce temps, personne ne la détache. Un lien inventé n'annule rien.
    expect((await geste(neuve, { geste: 'detacher', email: A1 })).map((x) => (typeof x === 'number' ? x : x?.error)), 'l\'ancienne peut annuler').toEqual([409, 'annulation_ouverte']);
    const faux = await avec(null, (ctx) => ctx.request.post(`${HUB_URL}/api/account/adresses/annuler`, { form: { token: 'a'.repeat(43) }, maxRedirects: 0 }));
    expect(faux.headers().location, 'lien inventé').toContain('result=invalide');
    expect(await adresses(neuve)).toMatchObject({ principale: A2 });
    return `prouvée par le fournisseur puis promue à l'écran ; même hub_user_id au Hub, dans Mail, CRM, Prospection et Analytics, aucun double ; ouvrir Mail (${mailAvant.source}) et le CRM rendent la même personne avant et après ; ancienne : plus d'entrée, gardée 72 h pour annuler ; refusés : sans session, non prouvée, d'un autre, autre adresse que demandée, session du fournisseur, rejouée, preuve perdue, autre organisation, Academy (encore par adresse)`;
  } finally {
    for (const t of [T, T2]) await admin('DELETE', `organisations/${t.id}/idp`).catch(() => undefined);
    await idp.fermer();
  }
}, { timeout: 1_200_000 });
