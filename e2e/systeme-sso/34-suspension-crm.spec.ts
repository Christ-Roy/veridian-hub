/**
 * Suspendre une organisation au Hub la ferme DANS le CRM (VER-254) : une session déjà ouverte (propriétaire et membre) et une clé API, en secondes ; le
 * rebond le dit ; l'organisation d'à côté ne bouge pas ; la reprise rend tout, la même session et la même clé, et ce que le CRM avait refusé d'appliquer
 * repart. Cochée au Hub, puis non cochée (CRM ouvert au compte). Enfin ce que DÉCOCHER le CRM ferme, mesuré.
 * NON PROUVÉ ici : 409 not_suspended_by_hub (il faudrait un espace fermé par un autre chemin ; tests), IMAP, 24 h.
 * Épreuves : `SSO_SABOTAGE=suspension-crm` ne suspend pas, `suspension-reprise` ne reprend pas : le cas doit échouer.
 */
import { expect, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, lookup } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, noterEspaceTwenty, ouvrirApp, type Compte } from './lib/parcours';

type Issue = { app: string; etat: string; detail?: string };
const DELAI = 30_000;

cas(null, 'suspension : le CRM ferme session et clé, puis les rend ; cochée et non cochée', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (organisations réglées, CRM réservé)');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const ouverts: BrowserContext[] = [];
  try {
    const compte = (e: string) => creerCompteProuve(browser, e, undefined, true);
    const [P, M, Q]: Compte[] = [await compte('suspp'), await compte('suspm'), await compte('suspq')];
    const espace = async (c: Compte) => {
      await activerTwentyAuHub(c.email);
      const t = (await lookup(c.email)).json?.tenants?.[0];
      if (!t) throw new NonAbouti('compte de test sans tenant');
      noterEspaceTwenty(c.email, t.id);
      return t as { id: string; slug: string };
    };
    const T = await espace(P);
    const T2 = await espace(Q);
    // T est cochée : M, jamais activé au CRM, y entre par l'organisation. T2 n'est pas réglée au Hub.
    await adminOk('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: 'TEST suspension', modules: ['crm'] });
    const ajout = await admin<{ organisation?: Issue[] }>('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
    expect(ajout.json.organisation?.map((e) => [e.app, e.etat]), JSON.stringify(ajout.json).slice(0, 200)).toEqual([['crm', 'applique']]);

    /** Une session CRM ouverte par le vrai rebond, et lue côté serveur du CRM. */
    const entrer = async (c: Compte, ctxDonne?: BrowserContext) => {
      const ctx = ctxDonne ?? (await browser.newContext({ storageState: c.etat as never }));
      if (!ctxDonne) ouverts.push(ctx);
      const a = await ouvrirApp(ctx, 'twenty');
      const origine = new URL(a.url).origin;
      const gql = async (query: string, variables: object = {}) => {
        const r = await ctx.request.post(`${origine}/metadata`, { headers: { origin: origine, 'x-twenty-session-cookie': '1' }, data: { query, variables } }).catch(() => null);
        return (await r?.json().catch(() => null)) as { data?: any; errors?: { message: string }[] } | null;
      };
      return { a, origine, gql, email: async () => ((await gql('{currentUser{email currentWorkspace{id}}}'))?.data?.currentUser?.email as string | undefined)?.toLowerCase() ?? null };
    };
    const cleDe = async (s: Awaited<ReturnType<typeof entrer>>) => {
      const role = ((await s.gql('{getApiKeyRoles{id label}}'))?.data?.getApiKeyRoles as { id: string; label: string }[] | undefined)?.find((r) => r.label === 'Admin');
      const fin = new Date(Date.now() + 86_400_000).toISOString();
      const id = (await s.gql('mutation($i:CreateApiKeyInput!){createApiKey(input:$i){id}}', { i: { name: 'TEST suspension', expiresAt: fin, roleId: role?.id } }))?.data?.createApiKey?.id;
      const jeton = (await s.gql('mutation($a:UUID!,$e:String!){generateApiKeyToken(apiKeyId:$a,expiresAt:$e){token}}', { a: id, e: fin }))?.data?.generateApiKeyToken?.token as string | undefined;
      if (!jeton) throw new NonAbouti('aucune clé CRM créée par la session du propriétaire');
      return async () => (await fetch(`${s.origine}/rest/companies?limit=1`, { headers: { authorization: `Bearer ${jeton}` }, signal: AbortSignal.timeout(15_000) })).status;
    };
    const [sP, sM, sQ] = [await entrer(P), await entrer(M), await entrer(Q)];
    expect([await sP.email(), await sM.email(), await sQ.email()], `entrées : ${sP.a.url} ${sM.a.url} ${sQ.a.url}`).toEqual([P, M, Q].map((c) => c.email.toLowerCase()));
    expect(sM.origine, 'M est dans l\'espace de T').toBe(sP.origine);
    const [kP, kQ] = [await cleDe(sP), await cleDe(sQ)];
    expect([await kP(), await kQ()], 'contrôle positif : les clés ouvrent').toEqual([200, 200]);

    const attendre = async (f: () => Promise<boolean>) => { const t0 = Date.now(); while (Date.now() - t0 < DELAI) { if (await f()) return Date.now() - t0; await new Promise((r) => setTimeout(r, 400)); } return null; };
    const basculer = async (t: { id: string }, suspendre: boolean) => {
      const r = await admin<{ apps: Issue[]; avis: string | null }>('POST', `tenants/${t.id}/suspension`, { suspendre, motif: 'TEST' });
      return { ...r.json, statut: r.status, crm: r.json.apps?.find((x) => x.app === 'crm') };
    };
    // Reprendre ce qui n'a jamais été suspendu : dit, quoi que le CRM réponde.
    const jamais = await basculer(T2, false);

    const jouer = async (nom: string, t: typeof T, siens: { s: Awaited<ReturnType<typeof entrer>>; c: Compte }[], k: () => Promise<number>, autre: { s: Awaited<ReturnType<typeof entrer>>; c: Compte; k: () => Promise<number> }) => {
      const coupure = sabotage === 'suspension-crm' ? null : await basculer(t, true);
      const session = await attendre(async () => (await Promise.all(siens.map((x) => x.s.email()))).every((e) => e === null));
      const cle = await attendre(async () => (await k()) !== 200);
      expect([coupure?.crm?.etat, session !== null, cle !== null], `${nom} : ${JSON.stringify(coupure?.apps)} session ${session} clé ${cle}`).toEqual(['suspendu', true, true]);
      expect([await autre.s.email(), await autre.k()], `${nom} : l'organisation d'à côté`).toEqual([autre.c.email.toLowerCase(), 200]);
      // Revenir par le Hub : il lit pourquoi, et n'entre pas.
      const retour = await browser.newContext({ storageState: siens.at(-1)!.c.etat as never });
      try {
        const a = await ouvrirApp(retour, 'twenty');
        expect([a.chemin, /Espace suspendu/.test(a.texte)], `${nom} : ${a.url} ${a.texte.slice(0, 160)}`).toEqual(['/auth/bounce/error', true]);
      } finally {
        await retour.close();
      }
      // Ce qui change pendant la suspension est refusé par le CRM, et dit.
      const refuse = nom === 'cochée' ? (await admin<{ emissions: Issue[] }>('PUT', `organisations/${t.id}`, { nom_affiche: 'TEST suspension bis' })).json.emissions : [];
      if (nom === 'cochée') expect(refuse.map((e) => [e.app, e.etat, e.detail]), JSON.stringify(refuse)).toEqual([['crm', 'echec', 'workspace_suspended']]);
      const reprise = sabotage === 'suspension-reprise' ? null : await basculer(t, false);
      const rendue = await attendre(async () => (await Promise.all(siens.map(async (x) => (await x.s.email()) === x.c.email.toLowerCase()))).every(Boolean));
      const cleRendue = await attendre(async () => (await k()) === 200);
      expect([reprise?.crm?.etat, rendue !== null, cleRendue !== null], `${nom} : reprise ${JSON.stringify(reprise?.apps)} session ${rendue} clé ${cleRendue}`).toEqual(['repris', true, true]);
      if (nom === 'cochée') {
        const apres = await adminOk<{ emissions: { app: string; a_jour: boolean }[] }>('GET', `organisations/${t.id}`);
        expect(apres.emissions.map((e) => [e.app, e.a_jour]), 'ce que la suspension avait retenu est appliqué').toEqual([['crm', true]]);
      }
      return `${nom} : session fermée en ${session} ms, clé en ${cle} ms, rendues en ${rendue} et ${cleRendue} ms`;
    };
    const un = await jouer('cochée', T, [{ s: sP, c: P }, { s: sM, c: M }], kP, { s: sQ, c: Q, k: kQ });
    const deux = await jouer('non cochée', T2, [{ s: sQ, c: Q }], kQ, { s: sP, c: P, k: kP });

    // Décocher le CRM : les portes du Hub se ferment ; la session déjà ouverte, on le mesure.
    const jetonM = await obtenirJetonMcp(browser, M, 'TEST SUSPENSION');
    const porte = async () => (JSON.parse((await outil(jetonM, 'chercher_outils', { besoin: 'lire les sociétés', app: 'twenty' })).texte) as { apps: string[] }).apps.includes('twenty');
    expect(await porte(), 'contrôle positif : la porte IA est ouverte').toBe(true);
    await adminOk('PUT', `organisations/${T.id}`, { modules: [] });
    expect(await porte(), 'décochée : porte IA').toBe(false);
    await new Promise((r) => setTimeout(r, 10_000));
    const session = (await sM.email()) === M.email.toLowerCase() ? 'VIT' : 'fermée';
    const neuf = await browser.newContext({ storageState: M.etat as never });
    let rebond = '';
    try {
      const s = await entrer(M, neuf);
      rebond = s.origine === sP.origine && (await s.email()) ? 'ENTRE dans l\'espace de l\'organisation' : `${s.a.hote}${s.a.chemin}`;
    } finally {
      await neuf.close();
    }
    return `${un} ; ${deux} ; jamais suspendue, reprise : crm ${jamais.crm?.etat} ${jamais.crm?.detail ?? ''} ; DÉCOCHÉ : porte IA fermée, session CRM de M ${session}, nouvelle entrée de M par le Hub : ${rebond}`;
  } finally {
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 1_200_000 });
