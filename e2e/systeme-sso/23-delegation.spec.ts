/**
 * Délégation entre apps (VER-245 b.2) : active par défaut entre apps ouvertes, coupée par le propriétaire, rallumée par son clic dans un vrai navigateur, échange d'une poignée
 * contre un jeton de 120 s, et la cible qui le reconnaît. Puis tout ce qui doit refuser : nonce rejoué, paire absente, liaison éteinte,
 * membre retiré, organisation suspendue. Staging et prod, organisation ordinaire (non marquée).
 * La poignée vient de la route admin des comptes de test.
 * Épreuve : `SSO_SABOTAGE=delegation` ne coupe pas la liaison : le cas doit échouer.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, lookup, secretDe, secretServiStaging } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, noterEspaceTwenty, type Compte } from './lib/parcours';

const STAGING = /staging/.test(HUB_URL);
const MCP_CRM = STAGING ? 'https://crm.staging.veridian.site/mcp' : 'https://crm.app.veridian.site/mcp';
const PAIRE = 'prospection>crm';

cas(null, 'délégation : le propriétaire ouvre une liaison, une app agit 120 s en son nom, et tout le reste refuse', async ({ browser }) => {
  const secret = STAGING ? secretServiStaging('PROSPECTION_TENANT_API_SECRET') : secretDe('PROSPECTION_TENANT_API_SECRET');
  const avant = (await adminOk<{ apps: { appKey: string }[] }>('GET', 'mcp-apps')).apps.find((a) => a.appKey === 'twenty');
  if (!avant) await adminOk('POST', 'mcp-apps', { app_key: 'twenty', label: 'CRM', mcp_url: MCP_CRM, acces: 'tous', enabled: true });
  try {
    const P: Compte = await creerCompteProuve(browser, 'delprop');
    const M: Compte = await creerCompteProuve(browser, 'delmembre');
    await activerTwentyAuHub(P.email);
    const T = (await lookup(P.email)).json?.tenants?.[0];
    if (!T) throw new NonAbouti('compte de test sans tenant');
    noterEspaceTwenty(P.email, T.id);
    const jetonP = await obtenirJetonMcp(browser, P, 'TEST DELEGATION');
    const regler = async (etat: string) => JSON.parse((await outil(jetonP, 'executer_outil', { nom: 'hub.integrations_regler', arguments: { paire: PAIRE, etat }, espace: T.slug })).texte);
    const etat = async (paire = PAIRE) => JSON.parse((await outil(jetonP, 'executer_outil', { nom: 'hub.integrations_lister', espace: T.slug })).texte).liaisons.find((l: { paire: string }) => l.paire === paire);

    const poignee = async (c: Compte) => {
      const r = await adminOk<{ delegations: { hub_tenant_id: string; grant: string }[] }>('POST', 'delegation/poignee', { email: c.email, app: 'prospection' });
      return r.delegations.find((d) => d.hub_tenant_id === T.id)?.grant;
    };
    const echanger = async (grant: string, o: { nonce?: string; corps?: object } = {}) => {
      const corps = JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_grant: grant, audience: 'crm', scope: 'crm:societe.ecrire crm:tache.ecrire', ...o.corps });
      const ts = String(Date.now());
      const nonce = o.nonce ?? randomBytes(18).toString('base64url');
      const r = await fetch(`${HUB_URL}/api/delegation/jeton`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-veridian-app': 'prospection', 'x-veridian-timestamp': ts, 'x-veridian-nonce': nonce, 'x-veridian-hub-signature': createHmac('sha256', secret).update(`${ts}.${nonce}.${corps}`).digest('hex') }, body: corps });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    };

    // Active par défaut (Robert, 25/11) : les deux apps sont ouvertes, personne n'a rien réglé ; elle ne se dit pas consentie. L'échange marche sans un clic.
    const g = await poignee(P);
    if (!g) throw new NonAbouti('aucune poignée émise');
    expect(await etat(), 'avant tout clic').toMatchObject({ etat: 'allumee', par_defaut: true, consentie: false, change_par: null });
    expect((await echanger(g)).status, 'sans un clic').toBe(200);
    expect(await etat(), 'le passage se garde, rien n\'est réglé').toMatchObject({ etat: 'allumee', par_defaut: true, consentie: false, dernier_passage: expect.any(String) });
    expect(await regler('allumee'), 'déjà active : rien à confirmer').toEqual({ etat: 'allumee' });
    // Une app pas ouverte dans l'organisation : sa liaison n'est pas active.
    const N: Compte = await creerCompteProuve(browser, 'delseule');
    const TN = (await lookup(N.email)).json?.tenants?.[0];
    const jetonN = await obtenirJetonMcp(browser, N, 'TEST DELEGATION');
    expect(JSON.parse((await outil(jetonN, 'executer_outil', { nom: 'hub.integrations_lister', espace: TN?.slug })).texte).liaisons.find((l: { paire: string }) => l.paire === PAIRE), 'sans CRM ouvert').toMatchObject({ etat: 'eteinte', par_defaut: false });
    // Les événements, eux, s'ouvrent à part : pas ici tant que le drapeau ne les ouvre pas.
    const evenement = await etat('notifuse>crm');
    expect(['indisponible', 'eteinte', 'allumee'], JSON.stringify(evenement)).toContain(evenement.etat);

    // Le propriétaire coupe : cela tient. Rallumer ce qui n'a jamais été consenti demande son clic.
    if (process.env.SSO_SABOTAGE !== 'delegation') expect(await regler('eteinte'), 'coupée').toEqual({ etat: 'eteinte' });
    expect((await echanger(g)).json, 'coupée').toEqual({ error: 'integration_off' });
    expect(await etat(), 'une coupure n\'est pas un défaut').toMatchObject({ etat: 'eteinte', par_defaut: false });
    const demande = await regler('allumee');
    expect(demande.etat).toBe('a_confirmer');
    expect((await etat()).etat, 'un lien n\'allume rien').toBe('eteinte');

    // Un autre compte n'y peut rien ; le propriétaire clique, dans un vrai navigateur.
    for (const [c, confirme] of [[M, false], [P, true]] as const) {
      const ctx = await browser.newContext({ storageState: c.etat as never });
      try {
        const page = await ctx.newPage();
        await page.goto(demande.lien, { waitUntil: 'networkidle' });
        const bouton = page.getByRole('button', { name: 'Allumer' });
        if (c === M) expect(await bouton.count(), 'un étranger ne voit pas le bouton').toBe(0);
        else if (confirme) {
          await expect(page.getByText('TEST DELEGATION', { exact: false }).first()).toBeVisible();
          await bouton.click();
          await expect(page.getByText('Liaison allumée')).toBeVisible();
        }
      } finally {
        await ctx.close();
      }
    }
    expect(await etat(), 'confirmée').toMatchObject({ etat: 'allumee', consentie: true, par_defaut: false });

    const nonce = randomBytes(18).toString('base64url');
    const r = await echanger(g, { nonce });
    expect([r.status, r.json?.expires_in, r.json?.tenant_id], JSON.stringify(r.json).slice(0, 200)).toEqual([200, 120, T.id]);
    const p = JSON.parse(Buffer.from(r.json.access_token.split('.')[1], 'base64url').toString());
    expect(p).toMatchObject({ sub: P.hubUserId, tenant_id: T.id, aud: MCP_CRM, act: { sub: 'app:prospection' }, scope: 'crm:societe.ecrire crm:tache.ecrire' });
    expect(p.exp - p.iat).toBe(120);

    // La cible lit un VRAI jeton émis par la porte : hors de ses portées, elle refuse comme une délégation, pas comme un inconnu.
    const crm = (jeton: string) => fetch(MCP_CRM, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${jeton}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    const c1 = await crm(r.json.access_token);
    const t1 = await c1.text();
    expect([c1.status, /delegation_forbidden/.test(t1)], t1.slice(0, 200)).toEqual([403, true]);

    expect((await echanger(g, { nonce })).json, 'nonce rejoué').toEqual({ error: 'nonce_replayed' });
    expect((await echanger(g, { corps: { audience: 'notifuse', scope: 'notifuse:contacts.ecrire' } })).json, 'autre liaison, active par défaut elle aussi').toMatchObject({ tenant_id: T.id });
    expect((await echanger(g, { corps: { scope: 'veridian' } })).json, 'portée hors paire').toEqual({ error: 'pair_not_allowed' });
    expect(await regler('eteinte'), 'éteinte').toEqual({ etat: 'eteinte' });
    expect((await echanger(g)).json, 'éteinte par l\'IA').toEqual({ error: 'integration_off' });
    expect(await regler('allumee'), 'rallumée sans nouveau clic').toEqual({ etat: 'allumee' });

    // Sans IA : la page Liaisons du Hub montre l'état, coupe et rallume ; un événement, pas encore servi, n'y est pas.
    const ctxP = await browser.newContext({ storageState: P.etat as never });
    try {
      const page = await ctxP.newPage();
      await page.goto(`${HUB_URL}/dashboard/liaisons`, { waitUntil: 'networkidle' });
      await expect(page.getByText('Prospection vers CRM', { exact: false })).toBeVisible();
      await expect(page.getByText('Active par défaut').first(), 'Prospection vers Mail : le dit').toBeVisible();
      const reglage = page.locator('form', { has: page.locator(`input[value="${PAIRE}"]`) });
      await reglage.getByRole('button', { name: 'Couper' }).click();
      await expect(page.getByText('Liaison coupée.')).toBeVisible();
      expect((await echanger(g)).json, 'coupée à l\'écran').toEqual({ error: 'integration_off' });
      await reglage.getByRole('button', { name: 'Allumer' }).click();
      await expect(page.getByText('Liaison allumée.')).toBeVisible();
    } finally {
      await ctxP.close();
    }

    // Membre : sa poignée marche, puis meurt avec son retrait. En prod le CRM est réservé : sans l'app, la délégation ne l'y fait pas entrer.
    if (!STAGING) {
      await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
      expect((await echanger((await poignee(M))!)).json, 'app réservée, pas ouverte à ce compte').toEqual({ error: 'app_not_open' });
      await activerTwentyAuHub(M.email);
      noterEspaceTwenty(M.email, (await lookup(M.email)).json.tenants[0].id);
    }
    await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
    const gm = await poignee(M);
    expect((await echanger(gm!)).status, 'membre').toBe(200);
    await admin('POST', `tenants/${T.id}/remove-member`, { hub_user_id: M.hubUserId });
    const t0 = Date.now();
    expect((await echanger(gm!)).json, 'retiré').toEqual({ error: 'grant_invalid' });
    const coupe = Date.now() - t0;
    const chezCrm = async (suspendre: boolean) => (await admin<{ apps: { app: string; etat: string; detail?: string }[] }>('POST', `tenants/${T.id}/suspension`, { suspendre })).json.apps?.find((x) => x.app === 'crm');
    expect(await chezCrm(true), 'fermé DANS le CRM (session et clé : cas 34)').toEqual({ app: 'crm', etat: 'suspendu' });
    expect((await echanger(g)).json, 'suspendue').toEqual({ error: 'grant_invalid' });
    expect(await chezCrm(false), 'rouvert dans le CRM').toEqual({ app: 'crm', etat: 'repris' });
    expect((await regler('allumee')).etat, 'la reprise redemande le clic').toBe('a_confirmer');
    return `jeton de 120 s reconnu par le CRM (403 delegation_forbidden hors portée), retiré refusé en ${coupe} ms, suspension fermée dans le CRM puis reprise, nonce, paire, éteinte : refusés`;
  } finally {
    if (!avant) await admin('DELETE', 'mcp-apps?app_key=twenty');
  }
}, { timeout: 480_000 });
