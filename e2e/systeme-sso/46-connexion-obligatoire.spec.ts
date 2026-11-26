/**
 * Connexion obligatoire par le fournisseur d'une organisation (VER-261). Sur ce qui est servi, organisation et fournisseur jetables : une session par mot de
 * passe n'ouvre AUCUNE porte de cette organisation (tableau de bord, écran, rebond, porte MCP, liaisons, jetons d'IA, échange entre apps), elle les ouvre
 * toutes une fois passée par le fournisseur ; l'autre organisation de la personne reste ouverte ; l'accès gardé tombe au rattachement ; libre rouvre tout.
 * NON PROUVÉ : une session par Google (aucun compte Google d'épreuve) : la garde ne lit pas le moyen, elle exige le passage (obligation.test.ts).
 * Épreuves : `SSO_SABOTAGE=obligatoire-libre` (la règle n'est pas posée), `obligatoire-exemptee` (elle garde son accès), `obligatoire-sans-passage` (elle ne
 * passe pas par le fournisseur), `obligatoire-sans-lien` (l'exemptée ne se rattache pas), `obligatoire-silence` (le fournisseur refuse aussi le second essai sans écran) : le cas doit échouer.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';

import { expect, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin, adminOk, lookup, marquerTest, secretDe } from './lib/hub-admin';
import { ouvrirIdp, type IdentiteDite } from './lib/idp-jetable';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, type Compte } from './lib/parcours';

const ORIGINE = { origin: new URL(HUB_URL).origin };
const T0 = Date.now();
/** Où en est le cas, lisible dans la sortie de la batterie : un dépassement dit son étape. */
/** Captures de l'écran servi, pour Robert : `.run/captures/46-*.png`. */
const CAPTURES = '.run/captures';
const pas = (n: string) => appendFileSync('.run/pas-46.txt', `${new Date().toISOString()} ${Math.round((Date.now() - T0) / 1000)} s : ${n}\n`);

cas(null, 'connexion obligatoire : aucune porte sans le fournisseur, toutes avec, l\'accès gardé tombe au rattachement, libre rouvre', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (organisations réglées)');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const ouverts: BrowserContext[] = [];
  pas('début : cinq comptes');
  const P: Compte = await creerCompteProuve(browser, 'oblprop');
  const Q: Compte = await creerCompteProuve(browser, 'oblautre');
  // M : membre des DEUX organisations. N : membre de celle-ci seulement. W : garde son accès jusqu'à son rattachement.
  const M: Compte = await creerCompteProuve(browser, 'oblm', undefined, true);
  const N: Compte = await creerCompteProuve(browser, 'obln', undefined, true);
  const W: Compte = await creerCompteProuve(browser, 'oblw', undefined, true);
  const org = async (c: Compte) => {
    const t = (await lookup(c.email)).json?.tenants?.[0] as { id: string; slug: string } | undefined;
    if (!t) throw new NonAbouti('compte de test sans organisation');
    await marquerTest(t.id);
    return t;
  };
  const [T, B] = [await org(P), await org(Q)];
  await adminOk('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: 'TEST OBLIGATOIRE', modules: ['prospection'] });
  for (const c of [M, N, W]) await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: c.hubUserId });
  await adminOk('POST', `tenants/${B.id}/members`, { hub_user_id: M.hubUserId });
  // Le domaine d'aiguillage est inventé : celui des comptes de batterie enverrait ailleurs les autres cas.
  const domaine = `o${randomBytes(4).toString('hex')}.e2e.veridian.site`;

  pas('comptes créés');
  const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
  const idp = await ouvrirIdp(ip, 'RS256');
  const regle = `organisations/${T.id}/connexion`;
  try {
    const CLIENT = { issuer: idp.issuer, client_id: idp.client.id, client_secret: idp.client.secret, domaines: [] };
    // Sans fournisseur, puis sans accès de secours : refusé, jamais de piège.
    expect((await admin('PUT', regle, { obligatoire: true })).json, 'sans fournisseur').toEqual({ error: 'fournisseur_absent' });
    expect((await admin('PUT', `organisations/${T.id}/idp`, CLIENT)).status).toBe(200);
    expect((await admin('PUT', regle, { obligatoire: true })).json, 'sans accès de secours').toEqual({ error: 'secours_manquant' });
    expect((await admin('PUT', regle, { aiguillage: ['gmail.com'] })).json, 'domaine public').toEqual({ error: 'domaine_public' });

    const navigateur = async (c: Compte) => {
      const ctx = await browser.newContext({ storageState: c.etat as never });
      ctx.setDefaultTimeout(45_000);
      ouverts.push(ctx);
      return ctx;
    };
    const [cm, cn, cw, cp] = [await navigateur(M), await navigateur(N), await navigateur(W), await navigateur(P)];
    const ou = async (ctx: BrowserContext, url: string) => {
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => undefined);
      const u = new URL(page.url());
      const r = { origine: u.origin, chemin: u.pathname, texte: (await page.locator('body').innerText().catch(() => '')).slice(0, 1_500), html: await page.content().catch(() => '') };
      await page.close();
      return r;
    };
    const rebond = (ctx: BrowserContext) => ou(ctx, `${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL.prospection}/`)}`);
    pas('jeton IA de M');
    const jetonM = await obtenirJetonMcp(browser, M, 'TEST OBLIGATOIRE');
    pas('jeton IA obtenu');
    const mcp = async (jeton: string, espace: string) => (await outil(jeton, 'executer_outil', { nom: 'hub.integrations_lister', espace })).isError;
    const activer = async (ctx: BrowserContext, tenant: string) => (await ctx.request.post(`${HUB_URL}/api/organisations/active`, { headers: ORIGINE, form: { tenant }, maxRedirects: 0 })).headers().location ?? '';
    const fil = async (ctx: BrowserContext, tenant: string) => (await ctx.request.get(`${HUB_URL}/api/ia/fil?app=academy&session=00000000-0000-4000-8000-000000000000&tenant=${tenant}`)).status();
    const grant = (await adminOk<{ delegations: { hub_tenant_id: string; grant: string }[] }>('POST', 'delegation/poignee', { email: M.email, app: 'prospection' })).delegations.find((d) => d.hub_tenant_id === T.id)?.grant;
    if (!grant) throw new NonAbouti('aucune poignée émise');
    const echanger = async () => {
      const corps = JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_grant: grant, audience: 'crm', scope: 'crm:societe.ecrire crm:tache.ecrire' });
      const [ts, nonce] = [String(Date.now()), randomBytes(18).toString('base64url')];
      const r = await fetch(`${HUB_URL}/api/delegation/jeton`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-veridian-app': 'prospection', 'x-veridian-timestamp': ts, 'x-veridian-nonce': nonce, 'x-veridian-hub-signature': createHmac('sha256', secretDe('PROSPECTION_TENANT_API_SECRET')).update(`${ts}.${nonce}.${corps}`).digest('hex') }, body: corps });
      return ((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? 'ok';
    };
    const portes = async (ctx: BrowserContext, jeton: string) => (pas('portes'), {
      rebond: (await rebond(ctx)).chemin === '/auth/organisation' ? 'fermée' : 'ouverte',
      mcp: (await mcp(jeton, T.slug)) ? 'fermée' : 'ouverte',
      active: /avis=active/.test(await activer(ctx, T.id)) ? 'ouverte' : 'fermée',
      ecran: (await ou(ctx, `${HUB_URL}/dashboard/organisation`)).html.includes(`value="${T.id}"`) ? 'ouverte' : 'fermée',
      assistant: (await fil(ctx, T.id)) === 404 ? 'fermée' : 'ouverte',
      echange: (await echanger()) === 'organisation_fournisseur' ? 'fermée' : 'ouverte',
    });
    const TOUTES = (x: string) => ({ rebond: x, mcp: x, active: x, ecran: x, assistant: x, echange: x });

    pas('Contrôle positif');
    // Contrôle positif : libre, tout est ouvert par la même session.
    expect(await portes(cm, jetonM), 'libre : la même session ouvre tout').toEqual(TOUTES('ouverte'));
    const autreAvant = await mcp(jetonM, B.slug);
    expect(autreAvant, 'témoin : l\'autre organisation').toBe(false);

    expect((await admin('POST', regle, { hub_user_id: P.hubUserId, nature: 'secours' })).status).toBe(200);
    expect((await admin('POST', regle, { hub_user_id: W.hubUserId, nature: 'rattachement' })).status).toBe(200);
    if (sabotage === 'obligatoire-exemptee') await adminOk('POST', regle, { hub_user_id: M.hubUserId, nature: 'rattachement' });
    if (sabotage !== 'obligatoire-libre') {
      const pose = await admin<{ obligatoire: boolean; personnes: { hub_user_id: string; acces: string }[] }>('PUT', regle, { obligatoire: true, aiguillage: [domaine] });
      const acces = (c: Compte) => pose.json.personnes.find((p) => p.hub_user_id === c.hubUserId)?.acces;
      expect([pose.status, pose.json.obligatoire, acces(P), acces(W), acces(N)]).toEqual([200, true, 'secours', 'actuel', 'ferme']);
    }

    pas('1. Session');
    if (sabotage === '') {
      mkdirSync(CAPTURES, { recursive: true });
      const org = await cp.newPage();
      await org.setViewportSize({ width: 1280, height: 1000 });
      await org.goto(`${HUB_URL}/dashboard/organisation`, { waitUntil: 'load' });
      await org.locator('section[aria-label="Connexion"]').first().scrollIntoViewIfNeeded().catch(() => undefined);
      await org.screenshot({ path: `${CAPTURES}/46-organisation.png`, fullPage: true });
      await org.close();
    }
    // 1. Session par mot de passe : chaque porte fermée, chacune relue ; l'autre organisation reste ouverte.
    expect(await portes(cm, jetonM), 'obligatoire, session par mot de passe').toEqual(TOUTES('fermée'));
    expect(await mcp(jetonM, B.slug), 'son autre organisation reste ouverte').toBe(false);
    expect(/avis=active/.test(await activer(cm, B.id)), 'son autre organisation se choisit').toBe(true);
    const compte = JSON.parse((await outil(jetonM, 'executer_outil', { nom: 'hub.mon_compte' })).texte);
    expect([compte.espaces.map((e: { slug: string }) => e.slug), compte.espaces_fermes.map((e: { slug: string }) => e.slug)], 'l\'IA sait pourquoi').toEqual([[B.slug], [T.slug]]);
    expect((await ou(cm, `${HUB_URL}/dashboard`)).chemin, 'son tableau de bord, pour l\'autre').toBe('/dashboard');
    // Celui qui n'a que celle-ci : l'écran, rien d'autre.
    const ecran = await ou(cn, `${HUB_URL}/dashboard`);
    if (sabotage === '') {
      const e = await cn.newPage();
      await e.goto(`${HUB_URL}/dashboard`, { waitUntil: 'load' });
      await e.screenshot({ path: `${CAPTURES}/46-demande.png`, fullPage: true });
      await e.close();
    }
    expect([ecran.chemin, /TEST OBLIGATOIRE/.test(ecran.texte), /Continuer avec/.test(ecran.texte)], ecran.texte).toEqual(['/auth/organisation', true, true]);
    expect((await ou(cn, `${HUB_URL}/dashboard/organisation`)).texte, 'l\'écran d\'organisation ne se lit pas').not.toMatch(/Personnes attendues|Nom affiché/);
    // Un membre n'y touche pas, le propriétaire (accès de secours) oui ; le dernier accès de secours ne s'enlève pas, et le fournisseur ne se coupe pas.
    expect((await cm.request.post(`${HUB_URL}/api/organisations/connexion`, { headers: ORIGINE, form: { tenant: T.id, geste: 'libre' }, maxRedirects: 0 })).headers().location ?? '').toContain('avis=proprietaire_seul');
    expect((await cp.request.post(`${HUB_URL}/api/organisations/connexion`, { headers: ORIGINE, form: { tenant: T.id, geste: 'retirer_acces', hub_user_id: String(P.hubUserId) }, maxRedirects: 0 })).headers().location ?? '').toContain('avis=dernier_secours');
    expect((await admin('DELETE', regle, { hub_user_id: P.hubUserId })).json, 'dernier accès de secours').toEqual({ error: 'dernier_secours' });
    expect((await ou(cp, `${HUB_URL}/dashboard`)).chemin, 'l\'accès de secours ouvre').toBe('/dashboard');

    pas('2. La page');
    // 2. La page de connexion : le domaine choisit, jamais le compte.
    const methode = async (email: string) => (await (await cp.request.post(`${HUB_URL}/api/auth/methode`, { headers: ORIGINE, data: { email } })).json()) as { methode: string; vers?: string };
    expect([(await methode(`inconnu@${domaine}`)), (await methode(N.email)).methode, (await methode('personne@domaine-inconnu.fr')).methode]).toEqual([expect.objectContaining({ methode: 'fournisseur', vers: `/connexion/${T.slug}` }), 'habituelle', 'habituelle']);
    const neuf = await browser.newContext();
    ouverts.push(neuf);
    neuf.setDefaultTimeout(45_000);
    const login = await neuf.newPage();
    await login.goto(`${HUB_URL}/login`, { waitUntil: 'load' });
    await login.locator('#email').fill(`quelquun@${domaine}`);
    await login.locator('#email').blur();
    await login.getByText(/Votre organisation se connecte avec/).waitFor();
    if (sabotage === '') await login.screenshot({ path: `${CAPTURES}/46-connexion.png`, fullPage: true });
    idp.dire({ sub: 'inconnu-1', email: 'x@y.fr', email_verified: false });
    await login.getByRole('button', { name: /^Continuer avec/ }).first().click();
    await login.waitForURL((u) => u.pathname === '/auth/premiere-entree');
    await login.close();

    pas('3. Elle passe');
    // 3. Elle passe par le fournisseur, sa session reste la sienne, et toutes les portes s'ouvrent.
    const passer = async (ctx: BrowserContext, qui: IdentiteDite) => {
      pas(`passer ${qui.sub}`);
      idp.dire(qui);
      // Un rebond refusé plus haut a laissé son cookie : il reprendrait vers l'app (voulu). Ici on mesure le passage seul.
      await ctx.clearCookies({ name: /veridian-next/ });
      const page = await ctx.newPage();
      await page.goto(`${HUB_URL}/auth/organisation?org=${T.id}`, { waitUntil: 'load' });
      await page.getByRole('button', { name: /^Continuer avec/ }).click();
      await page.waitForURL((u) => u.origin === new URL(HUB_URL).origin && !/\/api\/auth\/federation|\/auth\/organisation/.test(u.pathname))
        .catch(() => undefined);
      await page.waitForLoadState('load').catch(() => undefined);
      const u = new URL(page.url());
      await page.close();
      return `${u.pathname}${u.search}`;
    };
    if (sabotage !== 'obligatoire-sans-passage') expect(await passer(cm, { sub: 'obl-m', email: 'x@y.fr', email_verified: false })).toBe('/dashboard');
    pas('passée : session');
    const s = (await (await cm.request.get(`${HUB_URL}/api/auth/session`)).json())?.user as { email?: string; federe?: boolean } | undefined;
    expect([s?.email?.toLowerCase(), s?.federe ?? false], 'sa session à elle').toEqual([M.email.toLowerCase(), false]);
    // L'ancien jeton d'IA, donné avant, reste fermé ; un neuf, donné depuis cette session, ouvre.
    expect(await mcp(jetonM, T.slug), 'jeton donné avant le passage').toBe(true);
    pas('nouveau jeton IA');
    const jetonNeuf = await obtenirJetonMcp(browser, { etat: await cm.storageState() }, 'TEST OBLIGATOIRE');
    expect(await portes(cm, jetonNeuf), 'passée par le fournisseur').toEqual(TOUTES('ouverte'));
    expect((await mcp(jetonNeuf, B.slug)), 'l\'autre, toujours').toBe(false);
    // Une AUTRE session de la même personne, par mot de passe, ne l'ouvre pas : la preuve est de la session, pas du compte.
    pas('autre session de M');
    const cm2 = await navigateur(M);
    expect((await rebond(cm2)).chemin, 'une autre session, sans passage').toBe('/auth/organisation');
    // Une identité déjà prise par quelqu'un d'autre n'ouvre rien.
    expect(await passer(cn, { sub: 'obl-m', email: 'x@y.fr', email_verified: false })).toBe('/auth/federation?code=autre_identite');
    expect((await ou(cn, `${HUB_URL}/dashboard`)).chemin).toBe('/auth/organisation');

    pas('Par le fournisseur SEUL');
    // Essai sans écran (prompt=none), une fois par navigateur. Refusé par le fournisseur : le bouton revient, pas de boucle. Accepté : elle entre sans clic.
    pas('essai sans écran');
    const sans = async (ctx: BrowserContext) => {
      const page = await ctx.newPage();
      await page.goto(`${HUB_URL}/auth/organisation?org=${T.id}`, { waitUntil: 'load' });
      await page.waitForLoadState('load').catch(() => undefined);
      const u = new URL(page.url());
      const r = { chemin: `${u.pathname}${u.search}`, bouton: await page.getByRole('button', { name: /^Continuer avec/ }).count() };
      await page.close();
      return r;
    };
    idp.dire({ sub: 'obl-m', email: 'x@y.fr', email_verified: false });
    idp.silencieux('login_required');
    const refuse = await navigateur(M);
    const avantSilence = idp.prompts().length;
    expect(await sans(refuse), 'refusé sans écran : le bouton, une seule demande').toEqual({ chemin: `/auth/organisation?org=${T.id}&silence=echec`, bouton: 1 });
    expect(await sans(refuse), 'jamais deux fois : le bouton, sans nouvel essai').toEqual({ chemin: `/auth/organisation?org=${T.id}`, bouton: 1 });
    expect(idp.prompts().slice(avantSilence), 'un seul essai, sans écran').toEqual(['none']);
    if (sabotage !== 'obligatoire-silence') idp.silencieux(null);
    const accepte = await navigateur(M);
    await sans(accepte);
    expect((await rebond(accepte)).chemin === '/auth/organisation' ? 'fermée' : 'ouverte', 'accepté sans écran : ouverte, sans un clic').toBe('ouverte');

    // Par le fournisseur SEUL, celle qui a aussi son autre organisation n'entre pas : rien de l'autre ne se lit depuis la session de celle-ci.
    idp.dire({ sub: 'obl-m', email: 'x@y.fr', email_verified: false });
    const seul = await browser.newContext();
    ouverts.push(seul);
    const tente = await ou(seul, `${HUB_URL}/connexion/${T.slug}`);
    const sansSession = ((await (await seul.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: unknown } | null)?.user ?? null;
    expect([/autre organisation/.test(tente.texte), sansSession, (await ou(seul, `${HUB_URL}/dashboard`)).chemin], tente.texte).toEqual([true, null, '/login']);

    pas('4. Entrée');
    // 4. Entrée par le fournisseur seul : session fédérée, portes ouvertes.
    expect(await passer(cn, { sub: 'obl-n', email: 'x@y.fr', email_verified: false })).toBe('/dashboard');
    idp.dire({ sub: 'obl-n', email: 'x@y.fr', email_verified: false });
    const cf = await browser.newContext();
    ouverts.push(cf);
    expect([(await ou(cf, `${HUB_URL}/connexion/${T.slug}`)).chemin, (await rebond(cf)).chemin === '/auth/organisation'], 'session ouverte par le fournisseur').toEqual(['/dashboard', false]);

    pas("5. L'accès");
    // 5. L'accès gardé ouvre, puis tombe tout seul dès que la personne s'est rattachée.
    expect([(await ou(cw, `${HUB_URL}/dashboard`)).chemin, (await rebond(cw)).chemin === '/auth/organisation'], 'accès gardé').toEqual(['/dashboard', false]);
    const cw2 = await navigateur(W);
    if (sabotage !== 'obligatoire-sans-lien') {
      idp.dire({ sub: 'obl-w', email: 'x@y.fr', email_verified: false });
      await ou(cw2, `${HUB_URL}/connexion/${T.slug}`);
    }
    const apres = await admin<{ personnes: { hub_user_id: string; acces: string; exemption: string | null; exemption_tombee_le: string | null }[] }>('GET', regle);
    const w = apres.json.personnes.find((p) => p.hub_user_id === W.hubUserId);
    expect([w?.acces, w?.exemption, Boolean(w?.exemption_tombee_le)], 'tombé').toEqual(['fournisseur', null, true]);
    expect((await ou(cw, `${HUB_URL}/dashboard`)).chemin, 'sa session par mot de passe, sans passage').toBe('/auth/organisation');
    expect((await ou(cw2, `${HUB_URL}/dashboard`)).chemin, 'celle qui s\'est rattachée').toBe('/dashboard');
    expect((await admin('POST', regle, { hub_user_id: W.hubUserId, nature: 'rattachement' })).json).toEqual({ error: 'deja_reliee' });

    pas('6. Retour');
    // 6. Retour arrière, une commande : tout rouvre, par mot de passe.
    expect((await admin('PUT', regle, { obligatoire: false })).status).toBe(200);
    expect(await portes(cm2, jetonM), 'libre de nouveau').toEqual(TOUTES('ouverte'));
    expect((await methode(`inconnu@${domaine}`)).methode).toBe('habituelle');
    return 'libre : six portes ouvertes ; obligatoire : six fermées par mot de passe, l\'autre organisation ouverte ; passée par le fournisseur : six ouvertes, l\'ancien jeton d\'IA fermé, une autre session fermée ; accès gardé tombé au rattachement ; dernier secours tenu ; domaine sans compte ; libre : tout rouvre';
  } finally {
    await admin('PUT', regle, { obligatoire: false, aiguillage: [] }).catch(() => undefined);
    await admin('DELETE', `organisations/${T.id}/idp`).catch(() => undefined);
    await idp.fermer();
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 1_500_000 });
