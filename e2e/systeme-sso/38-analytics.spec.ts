/**
 * Analytics (VER-260) : retirer un membre ferme ce qu'il tenait déjà, et suspendre l'organisation ferme tout le monde SANS perdre les visites. Organisation
 * et site de test, créés pour ce cas, retirés avec lui ; jamais un client.
 *   Portes : session (liste des sites, statistiques), clé personnelle (REST et MCP de l'app), porte IA du Hub, lien de connexion non consommé. 65 s,
 *   un autre membre témoin. Suspension : mêmes portes du témoin, visites envoyées pendant, comptées après la reprise.
 * NON SONDÉ : clé d'organisation (un membre ne peut pas en créer), lien privé de site (dits, jamais coupés), JWT du Hub (la personne ne le tient pas).
 * Épreuves : `SSO_SABOTAGE=analytics-retrait` ne retire pas ; `analytics-suspension` ne suspend pas ; `analytics-visites` n'en envoie aucune : échec.
 */
import { expect, type APIRequestContext, type BrowserContext } from '@playwright/test';

import { membreDe, operateur, organisationDe, pagesVues, siteDe, visite } from './lib/analytics';
import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerAnalyticsAuHub, admin, lookup, marquerTest, rybbitCompte } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, ID_RUN, noterRybbit, ouvrirApp, type Compte } from './lib/parcours';

const A = APP_URL.analytics;
const DUREE = 65_000;
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
type Json = any;
type Issue = { app: string; etat: string; detail?: string; cles?: object; liens?: object };
const chez = (j: { apps?: Issue[] }) => j.apps?.find((a) => a.app === 'analytics');

cas(null, 'Analytics : un retrait ferme ce que la personne tenait ; une suspension ferme tout et compte quand même les visites', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const ouverts: BrowserContext[] = [];
  const op: APIRequestContext = await operateur();
  let site: { siteId: number; cleSuivi: string } | null = null;
  try {
    const P: Compte = await creerCompteProuve(browser, 'anprop');
    const M: Compte = await creerCompteProuve(browser, 'anmembre');
    const W: Compte = await creerCompteProuve(browser, 'antemoin');
    const T = (await lookup(P.email)).json?.tenants?.[0] as { id: string; slug: string } | undefined;
    if (!T) throw new NonAbouti('propriétaire sans organisation');
    await marquerTest(T.id);

    // Une organisation Analytics par client : celle de P, reliée à son tenant ; M et W y sont simples membres, entrés comme P par le Hub.
    [P, M, W].forEach((c) => noterRybbit(c.email));
    rybbitCompte('creer', P.email);
    const org = await organisationDe(op, P.email);
    const domaine = `${ID_RUN}.e2e-sso.invalid`.toLowerCase();
    site = await siteDe(op, org, domaine);
    for (const c of [M, W]) await membreDe(op, org, c.email);
    for (const c of [M, W]) await admin('POST', `tenants/${T.id}/members`, { hub_user_id: c.hubUserId });
    const ouvrir = async (c: Compte) => {
      const ctx = await browser.newContext({ storageState: c.etat as never });
      ouverts.push(ctx);
      for (let i = 0; i < 3; i++) {
        if (i) await pause(35_000);
        await ouvrirApp(ctx, 'analytics');
        if ((await ctx.request.get(`${A}/api/organizations/${org}/sites`)).status() === 200) return ctx;
      }
      throw new NonAbouti(`Analytics : ${c === P ? 'P' : c === M ? 'M' : 'W'} n'entre pas par le Hub`);
    };
    const contextes = new Map<Compte, BrowserContext>();
    const cP = await ouvrir(P);
    await activerAnalyticsAuHub(P.email);
    const tenir = async (c: Compte) => {
      const ctx = c === P ? cP : (contextes.get(c) ?? (await ouvrir(c)));
      const k = (await (await ctx.request.post(`${A}/api/user/api-keys`, { headers: { Origin: A }, data: { name: 'TEST retrait' } })).json().catch(() => null)) as Json;
      const cle = (k?.key ?? k?.data?.key ?? k?.apiKey) as string | undefined;
      if (!cle) throw new NonAbouti('Analytics : clé personnelle non créée');
      return { ctx, cle, ia: await obtenirJetonMcp(browser, c, 'TEST RETRAIT') };
    };
    // La porte IA d'Analytics s'ouvre par compte : M et W l'activent dans LEUR espace, l'organisation de P étant déjà reliée à la sienne.
    for (const c of [M, W]) {
      contextes.set(c, await ouvrir(c));
      await activerAnalyticsAuHub(c.email);
    }
    const [sP, sM, sW] = [await tenir(P), await tenir(M), await tenir(W)];
    type Personne = typeof sP;
    const slug = T.slug;
    const S = String(site.siteId);
    const bearer = (cle: string) => ({ authorization: `Bearer ${cle}` });
    const PORTES: Record<string, { tous: number; lit: (s: Personne) => Promise<boolean> }> = {
      session_sites: { tous: 700, lit: async (s) => { const r = await s.ctx.request.get(`${A}/api/organizations/${org}/sites`, { timeout: 15_000 }); return r.status() === 200 && (await r.text()).includes(domaine); } },
      session_stats: { tous: 700, lit: async (s) => (await pagesVues(s.ctx.request, site!.siteId)) !== null },
      cle_rest: { tous: 700, lit: async (s) => { const r = await fetch(`${A}/api/organizations/${org}/sites`, { headers: bearer(s.cle), signal: AbortSignal.timeout(15_000) }); return r.status === 200 && (await r.text()).includes(domaine); } },
      cle_mcp: { tous: 2_000, lit: async (s) => { const r = await fetch(`${A}/api/mcp`, { method: 'POST', headers: { ...bearer(s.cle), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sites', arguments: {} } }), signal: AbortSignal.timeout(15_000) }); return (await r.text()).includes(domaine); } },
      porte_ia: { tous: 6_000, lit: async (s) => { const x = await outil(s.ia, 'executer_outil', { nom: 'analytics.list_sites', arguments: {}, espace: slug }); return !x.isError && x.texte.includes(domaine); } },
    };
    const noms = Object.keys(PORTES);
    const lit = (x: string, s: Personne) => PORTES[x].lit(s).catch(() => false);
    for (const [qui, s] of [['propriétaire', sP], ['membre', sM], ['témoin', sW]] as const) {
      const fermees: string[] = [];
      for (const x of noms) if (!(await lit(x, s))) fermees.push(x === 'porte_ia' ? `porte_ia : ${(await outil(s.ia, 'executer_outil', { nom: 'analytics.list_sites', arguments: {}, espace: slug }).catch((e: Error) => ({ texte: e.message }))).texte.slice(0, 160)}` : x);
      expect(fermees, `contrôle positif, ${qui} (site ${S})`).toEqual([]);
    }
    const compter = async (n: number, quoi: string) => { let v: number | null = null; for (let i = 0; i < 30; i++) { v = await pagesVues(sP.ctx.request, site!.siteId); if (v === n) return; await pause(2_000); } throw new Error(`${quoi} : ${v} page(s) vue(s), ${n} attendue(s)`); };
    expect(await visite(site.cleSuivi, domaine, '/avant')).toBe(200);
    await compter(1, 'contrôle positif : une visite se compte');

    /** Chaque porte pendant 65 s : la dernière lecture de la cible, et ce que le témoin a perdu. */
    const sonder = async (cible: Personne, temoin: Personne | null) => {
      const t0 = Date.now();
      const dernier: Record<string, number> = {};
      const perdus = new Set<string>();
      await Promise.all(noms.map(async (x) => {
        while (Date.now() - t0 < DUREE) {
          const t = Date.now();
          if (await lit(x, cible)) dernier[x] = Math.max(1, t - t0);
          if (temoin && !(await lit(x, temoin)) && !(await lit(x, temoin))) perdus.add(x);
          await pause(PORTES[x].tous);
        }
      }));
      return { dernier, perdus: Array.from(perdus) };
    };

    // Le lien du rebond reçu avant, pas encore ouvert (2 min de vie).
    let lien = `${HUB_URL}/login?next=${encodeURIComponent(`${A}/`)}`;
    for (let i = 0; i < 8 && new URL(lien).host !== new URL(A).host; i++) lien = new URL((await sM.ctx.request.get(lien, { maxRedirects: 0 })).headers().location ?? `${A}/aucun`, lien).href;
    const ret = sabotage === 'analytics-retrait' ? null : await admin<{ apps: Issue[]; avis: string | null }>('POST', `tenants/${T.id}/remove-member`, { hub_user_id: M.hubUserId });
    const c1 = await browser.newContext();
    ouverts.push(c1);
    const p1 = await c1.newPage();
    await p1.goto(lien, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await p1.close();
    const apres = await sonder(sM, sW);
    const parLien = (await c1.request.get(`${A}/api/organizations/${org}/sites`)).status() === 200;
    expect([ret && chez(ret.json)?.etat, Object.entries(apres.dernier).filter(([, v]) => v >= 5_000).map(([x]) => x), parLien, apres.perdus], `retrait ${JSON.stringify(ret && chez(ret.json))} ; dernières lectures ${JSON.stringify(apres.dernier)}`).toEqual(['retire', [], false, []]);

    // Suspension : W et P tombent, l'opérateur garde ses autres organisations, les visites entrent toujours.
    const susp = sabotage === 'analytics-suspension' ? null : await admin<{ apps: Issue[] }>('POST', `tenants/${T.id}/suspension`, { suspendre: true, motif: 'test' });
    try {
      const envoyees = sabotage === 'analytics-visites' ? [] : [await visite(site.cleSuivi, domaine, '/pendant-1'), await visite(site.cleSuivi, domaine, '/pendant-2')];
      const ferme = await sonder(sW, null);
      const autre = (await op.get(`${A}/api/organizations`)).status();
      expect([susp && chez(susp.json)?.etat, Object.entries(ferme.dernier).filter(([, v]) => v >= 5_000).map(([x]) => x), autre], `suspension ${JSON.stringify(susp && chez(susp.json))} ; dernières lectures ${JSON.stringify(ferme.dernier)}`).toEqual(['suspendu', [], 200]);
      expect(envoyees, 'les visites sont acceptées pendant la suspension').toEqual(sabotage === 'analytics-visites' ? [] : [200, 200]);
    } finally {
      await admin('POST', `tenants/${T.id}/suspension`, { suspendre: false });
    }
    await expect.poll(async () => { const f: string[] = []; for (const x of noms) if (!(await lit(x, sW))) f.push(x); return f; }, { timeout: 60_000, message: 'reprise : le témoin relit partout' }).toEqual([]);
    await compter(3, 'visites de la suspension, après la reprise');
    expect((await Promise.all(noms.map((x) => lit(x, sM)))).filter(Boolean).length, 'la reprise ne rend rien au retiré').toBe(0);
    return `retrait : ${noms.length} portes et le lien, dernière lecture ${Math.max(0, ...Object.values(apres.dernier))} ms, témoin intact ; suspension : tout fermé, 2 visites envoyées pendant et comptées après ; reprise : témoin rendu, retiré non`;
  } finally {
    if (site) await op.delete(`${A}/api/sites/${site.siteId}`).catch(() => undefined);
    await op.dispose();
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 1_500_000 });
