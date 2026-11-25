/**
 * Suspendre une organisation au Hub la ferme DANS le CRM (VER-254) : une session déjà ouverte (propriétaire et membre) et une clé API, en secondes ; le
 * rebond le dit ; l'organisation d'à côté ne bouge pas ; la reprise rend tout, la même session et la même clé, et ce que le CRM avait refusé d'appliquer
 * repart. Cochée au Hub, puis non cochée (CRM ouvert au compte). Décocher : cas 35.
 * NON PROUVÉ ici : 409 not_suspended_by_hub (il faudrait un espace fermé par un autre chemin ; tests), IMAP, 24 h.
 * Épreuves : `SSO_SABOTAGE=suspension-crm` ne suspend pas, `suspension-reprise` ne reprend pas : le cas doit échouer.
 */
import { expect, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, lookup } from './lib/hub-admin';
import { creerCompteProuve, noterEspaceTwenty, ouvrirApp, type Compte } from './lib/parcours';

type Issue = { app: string; etat: string; detail?: string };
const DELAI = 30_000;
/** Au-delà, ce n'est plus une propagation : c'est une porte. */
const BORNE = 5_000;

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
      /** Ouverte = elle lit des DONNÉES. `currentUser` ne prouve rien : le CRM le laisse lire à un espace suspendu, pour l'écran qui l'explique (25/11). */
      const donnees = async () => {
        const r = await ctx.request.post(`${origine}/graphql`, { headers: { origin: origine, 'x-twenty-session-cookie': '1' }, data: { query: '{companies(first:1){edges{node{id}}}}' } }).catch(() => null);
        const j = (await r?.json().catch(() => null)) as { data?: { companies?: { edges?: unknown[] } } } | null;
        return Array.isArray(j?.data?.companies?.edges);
      };
      return { a, origine, gql, donnees, email: async () => ((await gql('{currentUser{email currentWorkspace{id}}}'))?.data?.currentUser?.email as string | undefined)?.toLowerCase() ?? null };
    };
    const roles = new Map<string, string | undefined>();
    const lus: string[] = [];
    const cleDe = async (s: Awaited<ReturnType<typeof entrer>>) => {
      const role = ((await s.gql('{getApiKeyRoles{id label}}'))?.data?.getApiKeyRoles as { id: string; label: string }[] | undefined)?.find((r) => r.label === 'Admin');
      roles.set(s.origine, role?.id);
      const fin = new Date(Date.now() + 86_400_000).toISOString();
      const id = (await s.gql('mutation($i:CreateApiKeyInput!){createApiKey(input:$i){id}}', { i: { name: 'TEST suspension', expiresAt: fin, roleId: role?.id } }))?.data?.createApiKey?.id;
      const jeton = (await s.gql('mutation($a:UUID!,$e:String!){generateApiKeyToken(apiKeyId:$a,expiresAt:$e){token}}', { a: id, e: fin }))?.data?.generateApiKeyToken?.token as string | undefined;
      if (!jeton) throw new NonAbouti('aucune clé CRM créée par la session du propriétaire');
      return async () => (await fetch(`${s.origine}/rest/companies?limit=1`, { headers: { authorization: `Bearer ${jeton}` }, signal: AbortSignal.timeout(15_000) })).status;
    };
    const [sP, sM, sQ] = [await entrer(P), await entrer(M), await entrer(Q)];
    expect([await sP.email(), await sM.email(), await sQ.email()], `entrées : ${sP.a.url} ${sM.a.url} ${sQ.a.url}`).toEqual([P, M, Q].map((c) => c.email.toLowerCase()));
    expect(sM.origine, 'M est dans l\'espace de T').toBe(sP.origine);
    expect([await sP.donnees(), await sM.donnees(), await sQ.donnees()], 'contrôle positif : les sessions lisent').toEqual([true, true, true]);
    const [kP, kQ] = [await cleDe(sP), await cleDe(sQ)];
    expect([await kP(), await kQ()], 'contrôle positif : les clés ouvrent').toEqual([200, 200]);

    const attendre = async (f: () => Promise<boolean>) => { const t0 = Date.now(); while (Date.now() - t0 < DELAI) { if (await f()) return Date.now() - t0; await new Promise((r) => setTimeout(r, 400)); } return null; };
    /**
     * La DERNIÈRE ouverture pendant 15 s, pas la première fermeture : le CRM a plusieurs processus, l'un peut servir encore quand l'autre a fermé (25/11,
     * une clé créée par la session d'un espace suspendu). 0 : jamais rouverte.
     */
    const derniereOuverture = async (f: () => Promise<boolean>) => { const t0 = Date.now(); let vu = 0; while (Date.now() - t0 < 15_000) { const t = Date.now(); if (await f()) vu = Math.max(1, t - t0); await new Promise((r) => setTimeout(r, 200)); } return vu; };
    const creerCle = async (s: Awaited<ReturnType<typeof entrer>>) => { const r = await s.gql('mutation($i:CreateApiKeyInput!){createApiKey(input:$i){id}}', { i: { name: 'TEST interdite', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), roleId: roles.get(s.origine) } }); return Boolean(r?.data?.createApiKey?.id); };
    const basculer = async (t: { id: string }, suspendre: boolean) => {
      const r = await admin<{ apps: Issue[]; avis: string | null }>('POST', `tenants/${t.id}/suspension`, { suspendre, motif: 'TEST' });
      return { ...r.json, statut: r.status, crm: r.json.apps?.find((x) => x.app === 'crm') };
    };
    // Reprendre ce qui n'a jamais été suspendu : dit, quoi que le CRM réponde.
    const jamais = await basculer(T2, false);

    const jouer = async (nom: string, t: typeof T, siens: { s: Awaited<ReturnType<typeof entrer>>; c: Compte }[], k: () => Promise<number>, autre: { s: Awaited<ReturnType<typeof entrer>>; c: Compte; k: () => Promise<number> }) => {
      const coupure = sabotage === 'suspension-crm' ? null : await basculer(t, true);
      const [session, cle, geste] = await Promise.all([derniereOuverture(async () => (await Promise.all(siens.map((x) => x.s.donnees()))).some(Boolean)), derniereOuverture(async () => (await k()) === 200), derniereOuverture(() => creerCle(siens[0].s))]);
      const ferme = `données ${session} ms, clé ${cle} ms, geste ${geste} ms après`;
      expect([coupure?.crm?.etat, session < BORNE, cle < BORNE, geste < BORNE], `${nom} : ${JSON.stringify(coupure?.apps)} dernière ouverture : ${ferme}`).toEqual(['suspendu', true, true, true]);
      expect([await autre.s.donnees(), await autre.k()], `${nom} : l'organisation d'à côté`).toEqual([true, 200]);
      const profil = (await siens[0].s.email()) ? 'profil encore lisible' : 'profil fermé';
      // Revenir par le Hub : il lit pourquoi, et n'entre pas.
      const retour = await browser.newContext({ storageState: siens.at(-1)!.c.etat as never });
      try {
        // Une erreur de navigation se LIT (boucle de redirection ou panne réseau), elle ne se devine pas sur une page vide.
        let a = { chemin: '', texte: '', erreur: '' };
        for (let i = 0; i < 3 && a.chemin !== '/auth/bounce/error'; i++) {
          const page = await retour.newPage();
          const erreur = await page.goto(`${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL.twenty}/`)}`, { waitUntil: 'networkidle' }).then(() => '', (e: Error) => e.message.split('\n')[0]);
          a = { chemin: new URL(page.url()).pathname, texte: await page.locator('body').innerText().catch(() => ''), erreur: [a.erreur, erreur].filter(Boolean).join(' / ') };
          await page.close();
          if (a.chemin !== '/auth/bounce/error') await new Promise((r) => setTimeout(r, 31_000)); // au-delà de l'anti-boucle du rebond
        }
        expect([a.chemin, /Espace suspendu/.test(a.texte)], `${nom} : ${a.erreur} ${a.texte.slice(0, 160)}`).toEqual(['/auth/bounce/error', true]);
        if (a.erreur) lus.push(`${nom} : navigation reprise après ${a.erreur}`);
      } finally {
        await retour.close();
      }
      // Réglée pendant la suspension : le Hub n'émet rien, et l'app repart à jour à la reprise.
      const refuse = nom === 'cochée' ? (await admin<{ emissions: Issue[] }>('PUT', `organisations/${t.id}`, { nom_affiche: 'TEST suspension bis' })).json.emissions : [];
      if (nom === 'cochée') expect(refuse.map((e) => [e.app, e.etat, e.detail]), JSON.stringify(refuse)).toEqual([]);
      const reprise = sabotage === 'suspension-reprise' ? null : await basculer(t, false);
      const rendue = await attendre(async () => (await Promise.all(siens.map((x) => x.s.donnees()))).every(Boolean));
      const cleRendue = await attendre(async () => (await k()) === 200);
      expect([reprise?.crm?.etat, rendue !== null, cleRendue !== null], `${nom} : reprise ${JSON.stringify(reprise?.apps)} session ${rendue} clé ${cleRendue}`).toEqual(['repris', true, true]);
      if (nom === 'cochée') {
        const apres = await adminOk<{ emissions: { app: string; a_jour: boolean }[] }>('GET', `organisations/${t.id}`);
        expect(apres.emissions.map((e) => [e.app, e.a_jour]), 'ce que la suspension avait retenu est appliqué').toEqual([['crm', true]]);
      }
      return `${nom} : dernière ouverture ${ferme} (${profil}), rendues en ${rendue} et ${cleRendue} ms`;
    };
    const un = await jouer('cochée', T, [{ s: sP, c: P }, { s: sM, c: M }], kP, { s: sQ, c: Q, k: kQ });
    const deux = await jouer('non cochée', T2, [{ s: sQ, c: Q }], kQ, { s: sP, c: P, k: kP });

    return `${un} ; ${deux} ;${lus.length ? ` ${lus.join(' ; ')} ;` : ''} jamais suspendue, reprise : crm ${jamais.crm?.etat} ${jamais.crm?.detail ?? ''}`;
  } finally {
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 1_200_000 });
