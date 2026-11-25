/**
 * Décocher une app réservée (parente, 25/11) : ceux venus PAR l'organisation en sortent, session ouverte comprise ; recocher les remet. Jamais le
 * propriétaire, jamais quelqu'un entré à la main. Rien de ce qu'ils ont écrit n'est effacé. CRM, puis Academy : la même règle. Organisation de test.
 * Épreuves : `SSO_SABOTAGE=decocher` ne décoche pas ; `decocher-main` ne fait pas entrer H à la main avant la coche : le cas doit échouer.
 */
import { createHmac } from 'node:crypto';

import { expect, type BrowserContext } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, appelTwenty, lookup, marquerTest, secretDe } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { consommer, fluxCrm, lienCrm, portesCrm } from './lib/portes-crm';
import { creerCompteProuve, noterEspaceTwenty, ouvrirApp, type Compte } from './lib/parcours';

type Reglee = { emissions: { app: string; etat: string; detail?: string | null }[]; retraits: { app: string; hub_user_id: string; etat: string; detail?: string }[] };

cas(null, 'décocher : ceux venus par l\'organisation sortent, les autres restent, recocher les remet', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (organisations réglées, apps réservées)');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const ouverts: BrowserContext[] = [];
  const fermer: (() => void)[] = [];
  try {
    const compte = (e: string) => creerCompteProuve(browser, e, undefined, true);
    const [P, M, H]: Compte[] = [await compte('decp'), await compte('decm'), await compte('dech')];
    const crmId = await activerTwentyAuHub(P.email);
    const T = (await lookup(P.email)).json?.tenants?.[0] as { id: string; slug: string } | undefined;
    if (!T) throw new NonAbouti('compte de test sans tenant');
    noterEspaceTwenty(P.email, T.id);
    await marquerTest(T.id);

    // H entre à la main, avant toute coche ; puis l'organisation coche, et M entre par elle.
    if (sabotage !== 'decocher-main') {
      const r = await appelTwenty('POST', `/api/veridian/workspaces/${crmId}/attach-member`, { hub_user_id: H.hubUserId, hub_user_email: H.email, email_proven: true, role: 'member' });
      if (!r.ok) throw new NonAbouti(`entrée de H à la main : HTTP ${r.status}`);
    }
    await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: H.hubUserId });
    const cocher = async (modules: string[]) => { const r = await admin<Reglee>('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: 'TEST décocher', modules }); return { statut: r.status, ...r.json }; };
    const un = await cocher(['crm']);
    expect([un.statut, un.emissions.map((e) => [e.app, e.etat]), un.retraits], JSON.stringify(un)).toEqual([200, [['crm', 'applique']], []]);
    await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });

    /** Le front du CRM finit d'ouvrir sa session après l'arrivée : on attend qu'elle lise (`attendue`), sinon rien ne serait mesuré. */
    const entrer = async (c: Compte, attendue = true) => {
      const ctx = await browser.newContext({ storageState: c.etat as never });
      ouverts.push(ctx);
      let a = await ouvrirApp(ctx, 'twenty');
      let origine = new URL(a.url).origin;
      const gql = async (query: string, variables: object = {}) => {
        const r = await ctx.request.post(`${origine}/graphql`, { headers: { origin: origine, 'x-twenty-session-cookie': '1' }, data: { query, variables } }).catch(() => null);
        return (await r?.json().catch(() => null)) as { data?: any; errors?: unknown[] } | null;
      };
      const lit = async () => Array.isArray((await gql('{companies(first:1){edges{node{id}}}}'))?.data?.companies?.edges);
      for (let i = 0, lu = !attendue; i < 3 && !lu; i++) {
        if (i) { a = await ouvrirApp(ctx, 'twenty'); origine = new URL(a.url).origin; }
        for (let k = 0; k < 10 && !(lu = await lit()); k++) await new Promise((r) => setTimeout(r, 2_000));
      }
      return { a, origine, gql, lit };
    };
    const [sP, sM, sH] = [await entrer(P), await entrer(M), await entrer(H)];
    expect([await sP.lit(), await sM.lit(), await sH.lit(), sM.origine === sP.origine, sH.origine === sP.origine], `entrées ${sM.a.url} ${sH.a.url}`).toEqual([true, true, true, true, true]);
    const nom = `TEST fiche de M ${Date.now().toString(36)}`;
    const fiche = (await sM.gql('mutation C($d: CompanyCreateInput!){createCompany(data:$d){id}}', { d: { name: nom } }))?.data?.createCompany?.id as string | undefined;
    if (!fiche) throw new NonAbouti('M n\'a pas pu écrire sa fiche');
    const ficheVue = async () => ((await sP.gql('query F($id: UUID!){company(filter:{id:{eq:$id}}){name}}', { id: fiche }))?.data?.company?.name as string | undefined) === nom;
    expect(await ficheVue(), 'contrôle positif : le propriétaire voit la fiche de M').toBe(true);
    const jetonM = await obtenirJetonMcp(browser, M, 'TEST DECOCHER');
    const porte = async () => (JSON.parse((await outil(jetonM, 'chercher_outils', { besoin: 'lire les sociétés', app: 'twenty' })).texte) as { apps: string[] }).apps.includes('twenty');
    expect(await porte(), 'contrôle positif : porte IA').toBe(true);

    // Ce que M et H tiennent hors du cookie : jeton, rafraîchissement, flux en direct (lib/portes-crm.ts). H est le témoin.
    const tenir = async (c: Compte) => {
      const { acces, long } = await consommer(sP.origine, await lienCrm(sP.origine, c));
      if (!acces || !long) throw new NonAbouti('jetons du CRM non obtenus');
      const flux = await fluxCrm(sP.origine, acces);
      fermer.push(flux.fermer);
      return { acces, long, flux };
    };
    const [tM, tH] = [await tenir(M), await tenir(H)];
    const portes = portesCrm(sP.origine);
    const creer = async () => (await sP.gql('mutation C($d: CompanyCreateInput!){createCompany(data:$d){id}}', { d: { name: `${nom} flux` } }))?.data?.createCompany?.id as string | undefined;
    const avantFlux = await creer();
    await expect.poll(() => [tM, tH].map((x) => x.flux.lignes.some((l) => l.texte.includes(avantFlux ?? '?'))), { timeout: 30_000, message: 'contrôle positif : le flux reçoit, chez M et H' }).toEqual([true, true]);

    /** La dernière lecture de M par chaque porte pendant 65 s, et tout du long le propriétaire et H, témoins. */
    const mesurer = async () => {
      const t0 = Date.now();
      const vu: Record<string, number> = {};
      const temoins: string[] = [];
      const fiches: { id: string; t: number }[] = [];
      const pendant = async (tous: number, geste: (t: number) => Promise<void>) => { while (Date.now() - t0 < 65_000) { await geste(Date.now()); await new Promise((r) => setTimeout(r, tous)); } };
      await Promise.all([
        pendant(250, async (t) => { if (await sM.lit()) vu.cookie = Math.max(1, t - t0); if (!(await sP.lit()) || !(await sH.lit())) temoins.push('cookie'); }),
        ...Object.entries(portes).map(([x, p]) => pendant(p.tous, async (t) => { if (await p.lit(tM).catch(() => false)) vu[x] = Math.max(1, t - t0); if (!(await p.lit(tH).catch(() => false)) && !(await p.lit(tH).catch(() => false))) temoins.push(x); })),
        pendant(4_000, async (t) => { const id = await creer(); if (id) fiches.push({ id, t }); }),
      ]);
      await new Promise((r) => setTimeout(r, 8_000));
      const recues = (x: typeof tM) => fiches.filter((f) => x.flux.lignes.some((l) => l.texte.includes(f.id)));
      for (const f of recues(tM)) vu.flux = Math.max(1, f.t - t0);
      if (fiches.length < 5 || recues(tH).length !== fiches.length) temoins.push(`flux ${recues(tH).length}/${fiches.length}`);
      return { vu, pire: Math.max(0, ...Object.values(vu)), temoins };
    };
    const deux = sabotage === 'decocher' ? null : await cocher([]);
    const coupe = await mesurer();
    expect([deux?.statut, deux?.retraits, coupe.pire < 5_000, coupe.temoins], `décochée : ${JSON.stringify(deux?.retraits)} dernières lectures ${JSON.stringify(coupe.vu)}, témoins perdus ${JSON.stringify(coupe.temoins)}`).toEqual([200, [{ app: 'crm', hub_user_id: M.hubUserId, etat: 'retire' }], true, []]);
    expect([await porte(), await ficheVue()], 'porte IA fermée, fiche intacte').toEqual([false, true]);
    const neuf = await entrer(M, false);
    expect(neuf.origine, `M ne rentre plus dans l'espace de l'organisation : ${neuf.a.url}`).not.toBe(sP.origine);

    // Recochée : elle revient, dans le même espace ; H et le propriétaire n'ont pas bougé. Redécochée : elle ressort.
    const trois = await cocher(['crm']);
    expect([trois.statut, trois.emissions.map((e) => [e.app, e.etat, e.detail ?? null])], JSON.stringify(trois)).toEqual([200, [['crm', 'applique', null]]]);
    const membres = async () => ((await sP.gql('{workspaceMembers(first:20){edges{node{userEmail}}}}'))?.data?.workspaceMembers?.edges as { node: { userEmail: string } }[]).map((e) => e.node.userEmail.toLowerCase()).sort();
    expect(await membres(), 'recochée').toEqual([H, M, P].map((c) => c.email.toLowerCase()).sort());
    expect(await porte(), 'recochée : porte IA').toBe(true);
    const quatre = await cocher([]);
    expect([quatre.retraits.map((x) => [x.hub_user_id, x.etat]), await membres()]).toEqual([[[M.hubUserId, 'retire']], [H, P].map((c) => c.email.toLowerCase()).sort()]);

    // Academy : la même règle.
    await adminOk('POST', 'tenants/app-access', { user_email: P.email, app: 'academy', enabled: true });
    const chezAcademy = async (c: Compte) => {
      const ts = String(Date.now());
      const r = await fetch(`https://academy.app.veridian.site/api/users/by-email?email=${encodeURIComponent(c.email)}&hub_user_id=${c.hubUserId}`, { headers: { 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': createHmac('sha256', secretDe('ACADEMY_HUB_API_SECRET')).update(`${ts}.`).digest('hex') }, signal: AbortSignal.timeout(30_000) });
      return (((await r.json().catch(() => null)) as { workspaces?: { hub_tenant_id: string }[] } | null)?.workspaces ?? []).some((w) => w.hub_tenant_id === T.id);
    };
    const cinq = await cocher(['academy']);
    expect([cinq.emissions.map((e) => [e.app, e.etat]), await chezAcademy(M), await chezAcademy(P)], JSON.stringify(cinq)).toEqual([[['academy', 'applique']], true, true]);
    const six = await cocher([]);
    expect([six.retraits.map((x) => [x.app, x.etat]).sort(), await chezAcademy(M), await chezAcademy(P)], JSON.stringify(six.retraits)).toEqual([[['academy', 'retire'], ['academy', 'retire']], false, true]);
    return `CRM : M venue par l'organisation sort (cookie, jeton, REST, identité, MCP, rafraîchissement, flux : dernière lecture ${coupe.pire} ms après, 65 s sondées), porte IA fermée, ne rentre plus, sa fiche reste ; H entré à la main et le propriétaire restent ; recochée : M revient ; redécochée : ressort. Academy : M et H, venus par elle, sortent, le propriétaire reste`;
  } finally {
    for (const f of fermer) f();
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 1_200_000 });
