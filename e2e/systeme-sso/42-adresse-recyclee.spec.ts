/**
 * L'adresse d'un compte supprimé ressert, sans rien hériter (VER-256, CONTRAT-HUB §5.19.8). M, membre de l'organisation de P, entre partout, puis son compte
 * est supprimé au Hub. Un compte NEUF naît avec la MÊME adresse : il entre partout (jamais « conflit »), chez lui seulement ; et ce que M tenait est fermé.
 * Comptes de batterie seulement. NON SONDÉ : Academy (réservée), Analytics (compte créé à la main).
 * Épreuve : `SSO_SABOTAGE=recycle-membre` ajoute le compte neuf à l'organisation : le cas doit échouer.
 */
import { expect, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, lookup, marquerTest, supprimerTenantHub } from './lib/hub-admin';
import { COMPAGNIES } from './lib/portes-crm';
import { creerCompteProuve, noterEspaceTwenty, ouvrirApp, type Compte } from './lib/parcours';

const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
type Vu = { prospection: string[] | null; mail: string[] | null; crm: string | null; erreurs: string[] };

/** Ce que cette session voit dans chaque app : ses espaces. Null : elle n'y entre pas. */
async function voir(ctx: BrowserContext, email: string): Promise<Vu> {
  const erreurs: string[] = [];
  const v: Vu = { prospection: null, mail: null, crm: null, erreurs };
  for (let i = 0; i < 3 && !v.prospection?.length; i++) {
    if (i) await pause(35_000); // anti-boucle du rebond : 30 s
    const a = await ouvrirApp(ctx, 'prospection');
    const me = (await (await ctx.request.get(`${APP_URL.prospection}/api/me`)).json().catch(() => null)) as { workspaces?: { id: string }[] } | null;
    v.prospection = me?.workspaces?.map((w) => w.id) ?? null;
    if (!v.prospection) erreurs.push(`prospection ${new URL(a.url).pathname}${new URL(a.url).search}`.slice(0, 160));
  }
  const page = await ctx.newPage();
  await page.goto(`${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL.notifuse}/console/`)}`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForFunction(() => Boolean(localStorage.getItem('auth_token')), undefined, { timeout: 45_000 }).catch(() => undefined);
  const jeton = await page.evaluate(() => localStorage.getItem('auth_token')).catch(() => null);
  if (!jeton) erreurs.push(`mail ${new URL(page.url()).pathname}${new URL(page.url()).search}`.slice(0, 160));
  await page.close();
  if (jeton) {
    const moi = (await (await ctx.request.get(`${APP_URL.notifuse}/api/user.me`, { headers: { Authorization: `Bearer ${jeton}` } })).json().catch(() => null)) as { user?: { email?: string }; workspaces?: { id: string }[] } | null;
    if (moi?.user?.email?.toLowerCase() !== email.toLowerCase()) erreurs.push('mail : autre personne');
    v.mail = moi?.workspaces?.map((w) => w.id) ?? null;
  }
  // Arrivé sur l'hôte ne veut pas dire entré : la session doit LIRE son espace (25/11 : la page de connexion du CRM comptait pour une entrée).
  for (let i = 0; i < 3 && !v.crm; i++) {
    if (i) await pause(35_000);
    const crm = new URL((await ouvrirApp(ctx, 'twenty')).url);
    for (let k = 0; k < 8 && !v.crm; k++) {
      const r = await ctx.request.post(`${crm.origin}/graphql`, { headers: { origin: crm.origin, 'x-twenty-session-cookie': '1' }, data: { query: COMPAGNIES }, timeout: 15_000 }).catch(() => null);
      if (((await r?.json().catch(() => null)) as { data?: { companies?: unknown } } | null)?.data?.companies) v.crm = crm.host;
      else await pause(2_000);
    }
    if (!v.crm) erreurs.push(`crm ${crm.host}${crm.pathname}${crm.search.slice(0, 60)}`);
  }
  return v;
}

cas(null, 'adresse recyclée : un compte neuf entre partout chez lui, et n\'hérite de rien', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (organisations réglées)');
  const ouverts: BrowserContext[] = [];
  const ctxDe = async (c: Compte) => { const x = await browser.newContext({ storageState: c.etat as never }); ouverts.push(x); return x; };
  try {
    const P: Compte = await creerCompteProuve(browser, 'recprop');
    const M: Compte = await creerCompteProuve(browser, 'recycle', undefined, true);
    await activerTwentyAuHub(P.email);
    const T = (await lookup(P.email)).json?.tenants?.[0] as { id: string; notifuseWorkspaceSlug?: string } | undefined;
    if (!T?.notifuseWorkspaceSlug) throw new NonAbouti('propriétaire sans espace Mail');
    noterEspaceTwenty(P.email, T.id);
    await marquerTest(T.id);
    await adminOk('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: 'TEST RECYCLE', modules: ['prospection', 'notifuse', 'crm'] });
    await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
    const [cP, cM] = [await ctxDe(P), await ctxDe(M)];
    const avantP = await voir(cP, P.email);
    const avantM = await voir(cM, M.email);
    const commun = (avantM.prospection ?? []).filter((x) => avantP.prospection?.includes(x));
    // Témoin : M est vraiment dans l'organisation, dans les trois apps ; sinon « n'hérite de rien » ne voudrait rien dire.
    if (!commun.length || !avantM.mail?.includes(T.notifuseWorkspaceSlug) || !avantM.crm || avantM.crm !== avantP.crm) throw new NonAbouti(`M n'est pas partout chez P : ${JSON.stringify({ avantM, crmP: avantP.crm, communs: commun.length })}`);

    expect((await supprimerTenantHub(M.email)).status, 'suppression au Hub').toBe(200);
    await pause(15_000); // le temps des coupures et de leurs reprises
    const N: Compte = await creerCompteProuve(browser, 'recycle', M.email);
    expect(N.hubUserId, 'une autre personne').not.toBe(M.hubUserId);
    const refusCrm = await activerTwentyAuHub(N.email).then(() => null, (err) => String(err instanceof Error ? err.message : err).slice(0, 200));
    const TN = (await lookup(N.email)).json?.tenants?.[0] as { id: string } | undefined;
    if (TN) noterEspaceTwenty(N.email, TN.id);
    if (process.env.SSO_SABOTAGE === 'recycle-membre') await admin('POST', `tenants/${T.id}/members`, { hub_user_id: N.hubUserId });
    const neuf = await voir(await ctxDe(N), N.email);
    const herite = {
      prospection: (neuf.prospection ?? []).filter((x) => (avantM.prospection ?? []).includes(x)).length,
      mail: (neuf.mail ?? []).filter((x) => (avantM.mail ?? []).includes(x)).length,
      crm: neuf.crm !== null && neuf.crm === avantM.crm ? 1 : 0,
    };
    const entre = { prospection: Boolean(neuf.prospection?.length), mail: Boolean(neuf.mail?.length), crm: Boolean(neuf.crm) };
    expect.soft(refusCrm, 'son espace CRM, ouvert par l\'opérateur').toBeNull();
    expect.soft(herite, 'ce que le compte neuf a hérité').toEqual({ prospection: 0, mail: 0, crm: 0 });
    expect.soft(entre, `il entre partout : ${[refusCrm, ...neuf.erreurs].filter(Boolean).join(' | ')}`).toEqual({ prospection: true, mail: true, crm: true });
    // Ce que M tenait est fermé, et ne s'est pas rouvert avec le compte neuf.
    const meM = (await (await cM.request.get(`${APP_URL.prospection}/api/me`)).json().catch(() => null)) as { workspaces?: unknown[] } | null;
    const hubM = ((await (await cM.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: unknown } | null)?.user ?? null;
    expect.soft([meM?.workspaces?.length ?? 0, hubM], 'sessions de M').toEqual([0, null]);
    const membres = (await admin<{ membres?: { email?: string }[]; members?: { email?: string }[] }>('GET', `tenants/${T.id}/members`)).json;
    expect.soft(JSON.stringify(membres ?? {}), 'plus membre chez P').not.toContain(N.hubUserId ?? '-');
    return `herite 0 ; entre partout ; M fermé`;
  } finally {
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 900_000 });
