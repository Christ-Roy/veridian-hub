/**
 * Retirer un membre ferme sa session DÉJÀ OUVERTE dans chaque app, en secondes (25/11 : le CRM retirait bien la personne, et sa session lisait encore).
 * Mail, CRM, Prospection ; NON MESURÉ : Academy, réservée à Robert, n'ouvre rien à un compte d'épreuve (son code relit l'appartenance à chaque requête).
 * Au CRM, deux portes : le cookie, et le jeton d'accès (30 min), que `revoke_sessions` ne coupe pas (CRM, 25/11 ; vu échouer sur crm v40).
 * La dernière lecture pendant 40 s (Prospection garde un contexte 30 s), le propriétaire témoin tout du long.
 * Épreuve : `SSO_SABOTAGE=retrait-session` ne retire pas : le cas doit échouer.
 */
import { expect, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, appelTwenty, lookup, marquerTest } from './lib/hub-admin';
import { creerCompteProuve, noterEspaceTwenty, ouvrirApp, type Compte } from './lib/parcours';

const BORNE = 5_000;

cas(null, 'retrait : la session ouverte du membre se ferme dans chaque app, en secondes', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (organisations réglées)');
  const ouverts: BrowserContext[] = [];
  try {
    const P: Compte = await creerCompteProuve(browser, 'rsprop');
    const M: Compte = await creerCompteProuve(browser, 'rsmembre', undefined, true);
    await activerTwentyAuHub(P.email);
    const T = (await lookup(P.email)).json?.tenants?.[0] as { id: string; slug: string; notifuseWorkspaceSlug?: string } | undefined;
    if (!T?.notifuseWorkspaceSlug) throw new NonAbouti('propriétaire sans espace Mail');
    noterEspaceTwenty(P.email, T.id);
    await marquerTest(T.id);
    const NOM = `TEST retrait ${Date.now().toString(36)}`;
    const r = await admin<{ emissions: { app: string; etat: string; detail?: string }[] }>('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: NOM, modules: ['prospection', 'notifuse', 'crm'] });
    expect(r.json.emissions?.map((e) => [e.app, e.etat]).sort(), JSON.stringify(r.json).slice(0, 300)).toEqual([['crm', 'applique'], ['notifuse', 'applique'], ['prospection', 'applique']]);
    const a = await admin<{ organisation?: { app: string; etat: string; detail?: string }[] }>('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
    expect(a.json.organisation?.every((e) => e.etat === 'applique' && !e.detail), JSON.stringify(a.json).slice(0, 400)).toBe(true);

    /** Une session par app, par le vrai rebond, et une lecture des données de l'organisation par elle. */
    const entrer = async (c: Compte) => {
      const ctx = await browser.newContext({ storageState: c.etat as never });
      ouverts.push(ctx);
      const crm = new URL((await ouvrirApp(ctx, 'twenty')).url).origin;
      await ouvrirApp(ctx, 'prospection');
      const page = await ctx.newPage();
      await page.goto(`${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL.notifuse}/console/`)}`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForFunction(() => Boolean(localStorage.getItem('auth_token')), undefined, { timeout: 45_000 }).catch(() => undefined);
      const jeton = await page.evaluate(() => localStorage.getItem('auth_token'));
      await page.close();
      const me = (await (await ctx.request.get(`${APP_URL.prospection}/api/me`)).json().catch(() => null)) as { workspaces?: { id: string; name: string }[] } | null;
      // Le jeton d'accès du CRM, tel que son écran l'obtient du lien de connexion ; gardé en mémoire, jamais affiché.
      const lien = (await (await appelTwenty('POST', '/api/sso/issue-magic-link', { hub_user_id: c.hubUserId, email: c.email, email_proven: true, next: `${crm}/` })).json().catch(() => null)) as { magic_link_url?: string } | null;
      const rebond = lien?.magic_link_url ? await fetch(lien.magic_link_url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) }) : null;
      const cible = new URL(rebond?.headers.get('location') ?? 'https://absent.invalid/');
      const echange = (await (await fetch(`${crm}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: crm }, body: JSON.stringify({ query: 'mutation($l:String!,$o:String!){getAuthTokensFromLoginToken(loginToken:$l,origin:$o){tokens{accessOrWorkspaceAgnosticToken{token}}}}', variables: { l: cible.searchParams.get('loginToken') ?? '', o: crm } }), signal: AbortSignal.timeout(20_000) })).json().catch(() => null)) as { data?: { getAuthTokensFromLoginToken?: { tokens?: { accessOrWorkspaceAgnosticToken?: { token?: string } } } } } | null;
      const jetonCrm = echange?.data?.getAuthTokensFromLoginToken?.tokens?.accessOrWorkspaceAgnosticToken?.token ?? null;
      return { ctx, crm, jeton, jetonCrm, espaces: (me?.workspaces ?? []).map((w) => w.id) };
    };
    const [sP, sM] = [await entrer(P), await entrer(M)];
    const commun = sM.espaces.find((x) => sP.espaces.includes(x));
    if (!commun) throw new NonAbouti(`Prospection : aucun espace commun (${sP.espaces.length} et ${sM.espaces.length})`);
    const lit = {
      mail: async (s: typeof sP) => (await s.ctx.request.get(`${APP_URL.notifuse}/api/contacts.list?workspace_id=${T.notifuseWorkspaceSlug}&limit=1`, { headers: { Authorization: `Bearer ${s.jeton}` }, timeout: 15_000 })).status() === 200,
      crm: async (s: typeof sP) => Array.isArray(((await (await s.ctx.request.post(`${sP.crm}/graphql`, { headers: { origin: sP.crm, 'x-twenty-session-cookie': '1' }, data: { query: '{companies(first:1){edges{node{id}}}}' }, timeout: 15_000 })).json().catch(() => null)) as { data?: { companies?: { edges?: unknown[] } } } | null)?.data?.companies?.edges),
      crm_jeton: async (s: typeof sP) => Array.isArray(((await (await fetch(`${sP.crm}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.jetonCrm}` }, body: JSON.stringify({ query: '{companies(first:1){edges{node{id}}}}' }), signal: AbortSignal.timeout(15_000) })).json().catch(() => null)) as { data?: { companies?: { edges?: unknown[] } } } | null)?.data?.companies?.edges),
      prospection: async (s: typeof sP) => (((await (await s.ctx.request.get(`${APP_URL.prospection}/api/me`, { timeout: 15_000 })).json().catch(() => null)) as { workspaces?: { id: string }[] } | null)?.workspaces ?? []).some((w) => w.id === commun),
    };
    type App = keyof typeof lit;
    const APPS = Object.keys(lit) as App[];
    const tous = async (s: typeof sP) => Object.fromEntries(await Promise.all(APPS.map(async (x) => [x, await lit[x](s).catch(() => false)]))) as Record<App, boolean>;
    const oui = { mail: true, crm: true, crm_jeton: true, prospection: true };
    expect([await tous(sP), await tous(sM)], 'contrôle positif : le propriétaire et le membre lisent partout').toEqual([oui, oui]);

    const ret = process.env.SSO_SABOTAGE === 'retrait-session' ? null : await admin<{ apps: { app: string; etat: string; detail?: string }[] }>('POST', `tenants/${T.id}/remove-member`, { hub_user_id: M.hubUserId });
    const t0 = Date.now();
    const dernier: Record<App, number> = { mail: 0, crm: 0, crm_jeton: 0, prospection: 0 };
    const temoin: Record<App, boolean> = { ...oui };
    await Promise.all(APPS.map(async (x) => {
      while (Date.now() - t0 < 40_000) {
        const t = Date.now();
        if (await lit[x](sM).catch(() => false)) dernier[x] = Math.max(1, t - t0);
        if (!(await lit[x](sP).catch(() => true))) temoin[x] = false;
        await new Promise((ok) => setTimeout(ok, 700));
      }
    }));
    expect([APPS.filter((x) => dernier[x] >= BORNE), temoin], `dernière lecture ${JSON.stringify(dernier)} ; retrait ${ret?.json.apps?.map((x) => `${x.app}=${x.etat}`).join(' ') ?? 'pas joué'}`).toEqual([[], oui]);
    return `dernière lecture après le retrait : ${APPS.map((x) => `${x} ${dernier[x]} ms`).join(', ')} ; le propriétaire lit tout du long`;
  } finally {
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 900_000 });
