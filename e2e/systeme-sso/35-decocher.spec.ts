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
import { creerCompteProuve, noterEspaceTwenty, ouvrirApp, type Compte } from './lib/parcours';

type Reglee = { emissions: { app: string; etat: string; detail?: string | null }[]; retraits: { app: string; hub_user_id: string; etat: string; detail?: string }[] };

cas(null, 'décocher : ceux venus par l\'organisation sortent, les autres restent, recocher les remet', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (organisations réglées, apps réservées)');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const ouverts: BrowserContext[] = [];
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

    const entrer = async (c: Compte) => {
      const ctx = await browser.newContext({ storageState: c.etat as never });
      ouverts.push(ctx);
      const a = await ouvrirApp(ctx, 'twenty');
      const origine = new URL(a.url).origin;
      const gql = async (query: string, variables: object = {}) => {
        const r = await ctx.request.post(`${origine}/graphql`, { headers: { origin: origine, 'x-twenty-session-cookie': '1' }, data: { query, variables } }).catch(() => null);
        return (await r?.json().catch(() => null)) as { data?: any; errors?: unknown[] } | null;
      };
      return { a, origine, gql, lit: async () => Array.isArray((await gql('{companies(first:1){edges{node{id}}}}'))?.data?.companies?.edges) };
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

    /** La dernière lecture de M pendant 15 s, et tout du long le propriétaire et H, témoins. */
    const mesurer = async () => {
      const t0 = Date.now();
      let vu = 0;
      let temoins = true;
      while (Date.now() - t0 < 15_000) {
        const t = Date.now();
        if (await sM.lit()) vu = Math.max(1, t - t0);
        temoins = temoins && (await sP.lit()) && (await sH.lit());
        await new Promise((r) => setTimeout(r, 250));
      }
      return { vu, temoins };
    };
    const deux = sabotage === 'decocher' ? null : await cocher([]);
    const coupe = await mesurer();
    expect([deux?.statut, deux?.retraits, coupe.vu < 5_000, coupe.temoins], `décochée : ${JSON.stringify(deux?.retraits)} dernière lecture ${coupe.vu} ms, témoins ${coupe.temoins}`).toEqual([200, [{ app: 'crm', hub_user_id: M.hubUserId, etat: 'retire' }], true, true]);
    expect([await porte(), await ficheVue()], 'porte IA fermée, fiche intacte').toEqual([false, true]);
    const neuf = await entrer(M);
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
    return `CRM : M venue par l'organisation sort (dernière lecture ${coupe.vu} ms après), porte IA fermée, ne rentre plus, sa fiche reste ; H entré à la main et le propriétaire restent ; recochée : M revient ; redécochée : ressort. Academy : M et H, venus par elle, sortent, le propriétaire reste`;
  } finally {
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 1_200_000 });
