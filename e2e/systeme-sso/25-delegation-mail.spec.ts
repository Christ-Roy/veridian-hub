/**
 * Prospection vers Mail (VER-245 b.2, F2) : un VRAI jeton de la porte, joué sur la route d'actions de Mail. Importe sans envoyer, une fois
 * par jeton, une fois par clé, et plus rien après le retrait. Staging, ou prod (26/11) : `notifuse` est dans `DELEGATION_CIBLES` de la prod. L'espace
 * Mail naît pour ce cas et meurt avec lui ; en prod, sur une organisation marquée de test et des comptes e2e-sso-, sans aucun envoi (l'import ne
 * fait partir aucun mail), et le registre MCP de prod n'est jamais écrit : l'entrée `notifuse` est lue, absente elle rend NON ABOUTI.
 * `SSO_GARDER_MAIL=1` garde l'espace.
 * Épreuve : `SSO_SABOTAGE=delegation-mail` rejoue le premier jeton au lieu d'en demander un neuf : le cas doit échouer.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { expect } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, lookup, marquerTest, secretDe, secretServiStaging } from './lib/hub-admin';
import { creerCompteProuve, noterEspaceTwenty, type Compte } from './lib/parcours';
import { signatureVersApp } from './lib/signature-app';

const PAIRE = 'prospection>notifuse';

cas(null, 'délégation vers Mail : importe sans envoyer, une fois par jeton et par clé, plus rien après le retrait', async ({ browser }) => {
  const STAGING = /staging/.test(HUB_URL);
  let MAIL = STAGING ? (/staging/.test(APP_URL.notifuse) ? APP_URL.notifuse : 'https://notifuse.staging.veridian.site') : APP_URL.notifuse;
  let ACTIONS = `${MAIL}/api/veridian/actions`;
  const secret = (nom: string) => (STAGING ? secretServiStaging(nom) : secretDe(nom));
  const prospection = secret('PROSPECTION_TENANT_API_SECRET');
  const mail = secret('NOTIFUSE_HUB_API_SECRET');
  const versMail = async (methode: string, chemin: string, corps?: object) => {
    const body = corps ? JSON.stringify(corps) : '';
    const r = await fetch(`${MAIL}${chemin}`, { method: methode, headers: { 'content-type': 'application/json', ...signatureVersApp('notifuse', mail, methode, `${MAIL}${chemin}`, body) }, body: body || undefined, signal: AbortSignal.timeout(60_000) });
    return { status: r.status, texte: (await r.text()).slice(0, 300) };
  };
  const slug = `e2edel${Date.now().toString(36)}`;
  let cree = false;
  let pose = false;
  try {
    if (!STAGING) {
      // Prod : le registre se LIT, jamais ne s'écrit. L'adresse d'action de Mail est celle que le Hub y a (même origine que son MCP).
      const entree = (await adminOk<{ apps: { appKey: string; mcpUrl?: string; enabled?: boolean }[] }>('GET', 'mcp-apps')).apps.find((a) => a.appKey === 'notifuse');
      if (!entree?.mcpUrl || entree.enabled === false) throw new NonAbouti('Mail absent (ou éteint) du registre MCP de prod : rien n\'est réinscrit, cas non joué');
      MAIL = new URL(entree.mcpUrl).origin;
      ACTIONS = new URL('/api/veridian/actions', entree.mcpUrl).toString();
    }
    const P: Compte = await creerCompteProuve(browser, 'mailprop');
    const M: Compte = await creerCompteProuve(browser, 'mailmembre');
    if (!STAGING && !(P.email.startsWith('e2e-sso-') && M.email.startsWith('e2e-sso-'))) throw new NonAbouti('comptes de test hors e2e-sso-… : refus de jouer en prod');
    await activerTwentyAuHub(P.email); // fait naître le tenant
    const T = (await lookup(P.email)).json?.tenants?.[0];
    if (!T) throw new NonAbouti('compte de test sans tenant');
    noterEspaceTwenty(P.email, T.id);
    if (!STAGING) await marquerTest(T.id); // organisation de test : jamais un client
    const prov = await versMail('POST', '/api/tenants/provision', { tenant_id: slug, owner_email: P.email, owner_hub_user_id: P.hubUserId, workspace_name: 'TEST délégation', plan: 'free', email_proven: true, metadata: { hub_user_id: P.hubUserId } });
    if (prov.status >= 300) throw new NonAbouti(`espace Mail de test : HTTP ${prov.status} ${prov.texte}`);
    cree = true;
    const lien = await versMail('POST', '/api/tenants/update-plan', { tenant_id: slug, plan: 'free', hub_tenant_id: T.id });
    if (lien.status >= 300) throw new NonAbouti(`lien de l'espace Mail : HTTP ${lien.status} ${lien.texte}`);
    if (STAGING && !(await adminOk<{ apps: { appKey: string }[] }>('GET', 'mcp-apps')).apps.some((a) => a.appKey === 'notifuse')) {
      await adminOk('POST', 'mcp-apps', { app_key: 'notifuse', label: 'Mail', mcp_url: `${MAIL}/api/mcp`, acces: 'tous', enabled: true });
      pose = true;
    }

    // Sans IA : le propriétaire allume la liaison par la page du Hub, et la confirme.
    const ctx = await browser.newContext({ storageState: P.etat as never });
    try {
      const page = await ctx.newPage();
      await page.goto(`${HUB_URL}/dashboard/liaisons`, { waitUntil: 'networkidle' });
      const formulaire = page.locator('form', { has: page.locator(`input[value="${PAIRE}"]`) });
      // Prod : la paire est allumée par défaut dans une organisation neuve (PAR_DEFAUT), il n'y a alors rien à allumer. Le jeton, lui, se mesure plus bas.
      const dejaAllumee = !STAGING && (await formulaire.getByRole('button', { name: 'Allumer' }).count()) === 0 && (await formulaire.getByRole('button', { name: 'Couper' }).count()) > 0;
      if (!dejaAllumee) {
        await formulaire.getByRole('button', { name: 'Allumer' }).click();
        await page.waitForURL(/\/liaisons\/confirmer\//);
        await page.getByRole('button', { name: 'Allumer' }).click();
        await expect(page.getByText('Liaison allumée')).toBeVisible();
      }
    } finally {
      await ctx.close();
    }

    const poignee = async (c: Compte) => (await adminOk<{ delegations: { hub_tenant_id: string; grant: string }[] }>('POST', 'delegation/poignee', { email: c.email, app: 'prospection' })).delegations.find((d) => d.hub_tenant_id === T.id)!.grant;
    const echanger = async (grant: string) => {
      const corps = JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_grant: grant, audience: 'notifuse', scope: 'notifuse:contacts.ecrire' });
      const ts = String(Date.now());
      const nonce = randomBytes(18).toString('base64url');
      const r = await fetch(`${HUB_URL}/api/delegation/jeton`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-veridian-app': 'prospection', 'x-veridian-timestamp': ts, 'x-veridian-nonce': nonce, 'x-veridian-hub-signature': createHmac('sha256', prospection).update(`${ts}.${nonce}.${corps}`).digest('hex') }, body: corps });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    };
    const g = await poignee(P);
    let premier: string | undefined;
    const jeton = async (): Promise<string> => {
      if (process.env.SSO_SABOTAGE === 'delegation-mail' && premier) return premier;
      const r = await echanger(g);
      expect([r.status, r.json?.url], JSON.stringify(r.json).slice(0, 200)).toEqual([200, ACTIONS]);
      premier ??= r.json.access_token as string;
      return r.json.access_token as string;
    };
    const agir = async (action: string, corps: object, o: { cle?: string; jeton?: string } = {}) => {
      const r = await fetch(`${ACTIONS}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.jeton ?? (await jeton())}`, ...(o.cle ? { 'Idempotency-Key': o.cle } : {}) }, body: JSON.stringify(corps), signal: AbortSignal.timeout(60_000) });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    };
    const bien = (r: { status: number; json: any }, quoi: string) => {
      expect(r.status, `${quoi} : ${JSON.stringify(r.json).slice(0, 300)}`).toBe(200);
      return r.json.resultat;
    };

    const cle = () => randomBytes(12).toString('hex');
    expect(bien(await agir('listes.creer', { id: 'testdelegation', name: 'TEST délégation' }, { cle: cle() }), 'liste').id).toBe('testdelegation');
    // Trois entreprises : Mail écarte deux contacts du même domaine dans un même lot.
    const contacts = [1, 2, 3].map((n) => ({ email: `contact@delegation${n}.invalid` }));
    const simule = bien(await agir('contacts.importer', { list_ids: ['testdelegation'], contacts, dry_run: true }), 'simulation');
    expect([simule.dry_run, simule.received], 'simulation').toEqual([true, 3]);
    const k = cle();
    const reel = bien(await agir('contacts.importer', { list_ids: ['testdelegation'], contacts, dry_run: false }, { cle: k }), 'import');
    expect([reel.dry_run, reel.received, reel.created], `importés : ${JSON.stringify(reel).slice(0, 300)}`).toEqual([false, 3, 3]);
    const rejoue = await agir('contacts.importer', { list_ids: ['testdelegation'], contacts, dry_run: false }, { cle: k });
    expect([rejoue.status, rejoue.json?.rejoue, rejoue.json?.resultat?.created], 'même clé : le premier résultat').toEqual([200, true, 3]);
    const autre = await agir('contacts.importer', { list_ids: ['testdelegation'], contacts: contacts.slice(0, 1), dry_run: false }, { cle: k });
    expect(autre.status, 'même clé, autre demande').toBe(422);

    const usage = await jeton();
    bien(await agir('listes.lister', {}, { jeton: usage }), 'lister');
    expect((await agir('listes.lister', {}, { jeton: usage })).status, 'jeton déjà vu').toBe(401);
    const mcp = await fetch(`${MAIL}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${await jeton()}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect([401, 403], 'un jeton d\'action n\'ouvre pas le MCP de Mail').toContain(mcp.status);

    // Un membre du Hub qui n'est pas dans l'espace Mail n'y entre pas par la délégation ; retiré, sa poignée meurt.
    await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
    const gm = await poignee(M);
    const jm = await echanger(gm);
    expect(jm.status, 'membre').toBe(200);
    const etranger = await agir('listes.lister', {}, { jeton: jm.json.access_token });
    expect(etranger.status, `non-membre de Mail : ${JSON.stringify(etranger.json).slice(0, 160)}`).toBe(403);
    await admin('POST', `tenants/${T.id}/remove-member`, { hub_user_id: M.hubUserId });
    expect((await echanger(gm)).json, 'retiré').toEqual({ error: 'grant_invalid' });
    return `espace ${slug}${process.env.SSO_GARDER_MAIL === '1' ? ' (gardé)' : ''} : vrai jeton accepté par Mail ; 3 contacts importés, rejeu 0, jeton usé 401, MCP ${mcp.status}, non-membre ${etranger.json?.error ?? etranger.status}, retiré refusé`;
  } finally {
    if (pose) await admin('DELETE', 'mcp-apps?app_key=notifuse');
    // SSO_GARDER_MAIL=1 : l'espace reste pour que la session Notifuse relise chez elle ; à retirer ensuite.
    if (cree && process.env.SSO_GARDER_MAIL !== '1') {
      const d = await versMail('DELETE', `/api/tenants/${slug}`);
      if (d.status >= 300 && d.status !== 404) console.error(`espace Mail ${slug} non retiré : HTTP ${d.status}`);
    }
  }
}, { timeout: 480_000 });
