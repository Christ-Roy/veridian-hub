/**
 * Retirer un membre ferme tout ce qu'il tenait DÉJÀ dans chaque app, en secondes, et rien de ce que tiennent les autres (25/11 : le CRM retirait bien
 * la personne, et sa session lisait encore ; puis on a dit « fermé » sur le seul cookie). Chaque porte est sondée 65 s ; deux témoins : le propriétaire,
 * et un autre membre ordinaire.
 *   Hub : porte IA vers le CRM, Mail et Prospection. CRM : cookie, jeton d'accès (GraphQL, REST, identité, MCP), rafraîchissement, flux en direct,
 *   lien de connexion non consommé. Mail : jeton de session, boîte unifiée, flux en direct, accès de boîte IMAP créé par elle, lien non consommé.
 *   Prospection : session (liste des espaces, et une donnée de l'espace), lien non consommé.
 * NON SONDÉ : Academy (réservée à Robert, rien ne s'ouvre à un compte d'épreuve) ; Analytics (aucune route de retrait, le Hub dit `non_gere`) ; clés API
 * d'espace (un membre ne peut pas en créer, comptées à l'auteur du geste) ; lien de fichier signé du CRM ; ce qu'un message Mail livrerait dans le flux.
 * Épreuve : `SSO_SABOTAGE=retrait-session` ne retire pas : le cas doit échouer, et CHAQUE porte doit y être vue lire jusqu'au bout.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { connect } from 'node:tls';

import { expect, type Browser, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, appelTwenty, lookup, marquerTest } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { COMPAGNIES, consommer, ecouter, fluxCrm, graphql, lienCrm, portesCrm } from './lib/portes-crm';
import { creerCompteProuve, noterEspaceTwenty, ouvrirApp, type Compte } from './lib/parcours';

const BORNE = 5_000;
const DUREE = 65_000;
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
type Json = any;

/** Ouvre la boîte par IMAP, comme un téléphone : connexion puis dossier. Le mot de passe ne quitte pas la mémoire. */
function imap(hote: string, utilisateur: string, secret: string): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect({ host: hote, port: 443, servername: hote });
    let recu = '';
    let etape = 0;
    const finir = (v: boolean) => { s.destroy(); ok(v); };
    s.setTimeout(12_000, () => finir(false));
    s.on('error', () => finir(false));
    s.on('close', () => ok(false));
    s.on('data', (d) => {
      recu += d.toString('utf8');
      if (etape === 0 && /^\* OK/m.test(recu)) { etape = 1; recu = ''; s.write(`a1 LOGIN "${utilisateur}" "${secret}"\r\n`); }
      else if (etape === 1 && /^a1 /m.test(recu)) { if (!/^a1 OK/m.test(recu)) return finir(false); etape = 2; recu = ''; s.write('a2 SELECT INBOX\r\n'); }
      else if (etape === 2 && /^a2 /m.test(recu)) finir(/^a2 OK/m.test(recu));
    });
  });
}

const jetonMail = async (ctx: BrowserContext, url: string): Promise<string | null> => {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForFunction(() => Boolean(localStorage.getItem('auth_token')), undefined, { timeout: 45_000 }).catch(() => undefined);
  const j = await page.evaluate(() => localStorage.getItem('auth_token')).catch(() => null);
  await page.close();
  return j;
};

/** Le lien du rebond, suivi à la main et jamais ouvert : on s'arrête au seuil de l'app. */
async function lienRebond(ctx: BrowserContext, app: 'prospection' | 'notifuse'): Promise<string> {
  const hote = new URL(APP_URL[app]).host;
  let url = `${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL[app]}/`)}`;
  for (let i = 0; i < 8; i++) {
    const suite = (await ctx.request.get(url, { maxRedirects: 0, timeout: 20_000 })).headers().location;
    if (!suite) return '';
    url = new URL(suite, url).href;
    if (new URL(url).host === hote) return url;
  }
  return '';
}

cas(null, 'retrait : tout ce que le membre tenait déjà se ferme dans chaque app, en secondes', async ({ browser }: { browser: Browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (organisations réglées)');
  const ouverts: BrowserContext[] = [];
  const fermer: (() => void)[] = [];
  try {
    const P: Compte = await creerCompteProuve(browser, 'rsprop');
    const M: Compte = await creerCompteProuve(browser, 'rsmembre', undefined, true);
    const W: Compte = await creerCompteProuve(browser, 'rstemoin', undefined, true);
    await activerTwentyAuHub(P.email);
    const T = (await lookup(P.email)).json?.tenants?.[0] as { id: string; slug: string; notifuseWorkspaceSlug?: string } | undefined;
    const MAIL = T?.notifuseWorkspaceSlug;
    if (!T || !MAIL) throw new NonAbouti('propriétaire sans espace Mail');
    noterEspaceTwenty(P.email, T.id);
    await marquerTest(T.id);
    const NOM = `TEST retrait ${Date.now().toString(36)}`;
    const r = await admin<{ emissions: { app: string; etat: string; detail?: string }[] }>('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: NOM, modules: ['prospection', 'notifuse', 'crm'] });
    expect(r.json.emissions?.map((e) => [e.app, e.etat]).sort(), JSON.stringify(r.json).slice(0, 300)).toEqual([['crm', 'applique'], ['notifuse', 'applique'], ['prospection', 'applique']]);
    for (const c of [M, W]) {
      const a = await admin<{ organisation?: { app: string; etat: string; detail?: string }[] }>('POST', `tenants/${T.id}/members`, { hub_user_id: c.hubUserId });
      expect(a.json.organisation?.every((e) => e.etat === 'applique' && !e.detail), JSON.stringify(a.json).slice(0, 400)).toBe(true);
    }

    /** Tout ce qu'une personne tient, par les vrais chemins. */
    const entrer = async (c: Compte) => {
      const ctx = await browser.newContext({ storageState: c.etat as never });
      ouverts.push(ctx);
      // Le front du CRM finit d'ouvrir sa session après l'arrivée (9 à 14 s sous charge) : on attend qu'elle lise, sinon rien ne serait mesuré.
      let crm = '';
      for (let i = 0, lu = false; i < 3 && !lu; i++) {
        crm = new URL((await ouvrirApp(ctx, 'twenty')).url).origin;
        for (let k = 0; k < 10 && !lu; k++) {
          const x = await ctx.request.post(`${crm}/graphql`, { headers: { origin: crm, 'x-twenty-session-cookie': '1' }, data: { query: COMPAGNIES }, timeout: 15_000 }).catch(() => null);
          lu = Boolean(((await x?.json().catch(() => null)) as Json)?.data?.companies);
          if (!lu) await pause(2_000);
        }
      }
      // Même patience : sur un bastion saturé, le navigateur a abandonné au bout de 30 s un lien bien émis (25/11, 13:42).
      let me: { workspaces?: { id: string }[] } | null = null;
      for (let i = 0; i < 3 && !me?.workspaces?.length; i++) {
        if (i) await pause(35_000); // anti-boucle du rebond : 30 s
        await ouvrirApp(ctx, 'prospection');
        me = await (await ctx.request.get(`${APP_URL.prospection}/api/me`)).json().catch(() => null);
      }
      const jeton = await jetonMail(ctx, `${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL.notifuse}/console/`)}`);
      const { acces, long } = await consommer(crm, await lienCrm(crm, c));
      if (!jeton || !acces || !long) throw new NonAbouti(`entrée incomplète : mail ${Boolean(jeton)}, jeton CRM ${Boolean(acces)}, rafraîchissement ${Boolean(long)}`);
      return { c, ctx, crm, jeton, acces, long, ia: await obtenirJetonMcp(browser, c, 'TEST RETRAIT'), espaces: (me?.workspaces ?? []).map((w) => w.id), boite: '', mail: { lignes: [] as { t: number; texte: string }[], ouvert: () => false }, direct: { lignes: [] as { t: number; texte: string }[], ouvert: () => false } };
    };
    type Personne = Awaited<ReturnType<typeof entrer>>;
    const [sP, sM, sW] = [await entrer(P), await entrer(M), await entrer(W)];
    const tous3 = [sP, sM, sW];
    const CRM = sP.crm;
    const commun = sM.espaces.find((x) => sP.espaces.includes(x) && sW.espaces.includes(x));
    if (!commun) throw new NonAbouti(`Prospection : aucun espace commun (${tous3.map((s) => s.espaces.length)})`);

    // Une donnée de l'espace dans Prospection, posée par le propriétaire : la lire prouve l'espace, pas seulement la session.
    const atlas = async (s: Personne, nom: string, corps: object) => (await s.ctx.request.post(`${APP_URL.prospection}/api/atlas/${nom}`, { data: corps, timeout: 15_000 }));
    const DOSSIER = `${NOM} dossier`;
    const d = await atlas(sP, 'creer_dossier', { nom: DOSSIER });
    if (!d.ok()) throw new NonAbouti(`Prospection : dossier non créé, HTTP ${d.status()}`);

    // Un profil d'envoi (aucun mail ne part : hôte inexistant), sur lequel chacun crée son accès de boîte, comme pour son téléphone.
    const mailApi = (s: Personne, chemin: string, data?: object) => s.ctx.request.fetch(`${APP_URL.notifuse}${chemin}`, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${s.jeton}` }, ...(data ? { data } : {}), timeout: 15_000 });
    const profil = await mailApi(sP, '/api/workspaces.createIntegration', { workspace_id: MAIL, name: NOM, type: 'email', provider: { kind: 'smtp', smtp: { host: 'smtp.invalid', port: 587, username: 'x', password: 'x', use_tls: true }, senders: [{ email: P.email, name: 'TEST', is_default: true }], rate_limit_per_minute: 1 } });
    const profilId = ((await profil.json().catch(() => null)) as Json)?.integration_id as string | undefined;
    if (!profilId) throw new NonAbouti(`Mail : profil non créé, HTTP ${profil.status()} ${(await profil.text()).slice(0, 160)}`);
    let hoteImap = '';
    for (const s of tous3) {
      const b = await mailApi(s, '/api/veridian/mail.access.create', { workspace_id: MAIL, profile_id: profilId, label: NOM });
      const j = (await b.json().catch(() => null)) as Json;
      if (b.status() !== 201 || !j?.password) throw new NonAbouti(`Mail : accès de boîte non créé, HTTP ${b.status()} ${JSON.stringify(j).slice(0, 160)}`);
      s.boite = j.password as string;
      hoteImap = 'imap.veridian.site';
      const f = await ecouter(`${APP_URL.notifuse}/api/veridian/mail.events?workspace_id=${MAIL}&direction=any`, { headers: { Authorization: `Bearer ${s.jeton}`, accept: 'text/event-stream' } });
      if (f.statut !== 200) throw new NonAbouti(`Mail : flux, HTTP ${f.statut}`);
      fermer.push(f.fermer);
      s.mail = f;
      const g = await fluxCrm(CRM, s.acces);
      fermer.push(g.fermer);
      s.direct = g;
    }

    const slug = (JSON.parse((await outil(sM.ia, 'executer_outil', { nom: 'hub.mon_compte' })).texte) as { espaces: { slug: string }[] }).espaces[0]?.slug;
    if (!slug) throw new NonAbouti('la porte IA ne montre aucun espace au membre');
    const ia = async (s: Personne, nom: string, args: object) => { const x = await outil(s.ia, 'executer_outil', { nom, arguments: args, espace: slug }); return !x.isError && !/inconnu pour ce compte|suspendu/.test(x.texte); };
    const lireMail = async (jeton: string | null) => (await fetch(`${APP_URL.notifuse}/api/contacts.list?workspace_id=${MAIL}&limit=1`, { headers: { Authorization: `Bearer ${jeton}` }, signal: AbortSignal.timeout(15_000) })).status === 200;

    // Le flux du CRM n'est lu que si une fiche créée APRÈS l'essai précédent y arrive ; celui de Mail, s'il bat encore (battement toutes les 15 s).
    const fiches: { id: string; t: number }[] = [];
    const creerFiche = async () => {
      const id = (await graphql(CRM, sP.acces, 'mutation($d:CompanyCreateInput!){createCompany(data:$d){id}}', { d: { name: `${NOM} ${fiches.length}` } }))?.data?.createCompany?.id as string | undefined;
      if (id) fiches.push({ id, t: Date.now() });
    };
    const PORTES: Record<string, { tous: number; lit: (s: Personne) => Promise<boolean> }> = {
      ia_crm: { tous: 6_000, lit: (s) => ia(s, 'twenty.find_many_people', { limit: 1, select: ['id'] }) },
      ia_mail: { tous: 6_000, lit: (s) => ia(s, 'notifuse.contacts_list', { limit: 1 }) },
      ia_prospection: { tous: 6_000, lit: (s) => ia(s, 'prospection.lister_segments_atlas', {}) },
      crm_cookie: { tous: 700, lit: async (s) => Array.isArray(((await (await s.ctx.request.post(`${CRM}/graphql`, { headers: { origin: CRM, 'x-twenty-session-cookie': '1' }, data: { query: COMPAGNIES }, timeout: 15_000 })).json().catch(() => null)) as Json)?.data?.companies?.edges) },
      ...portesCrm(CRM),
      mail_session: { tous: 700, lit: (s) => lireMail(s.jeton) },
      mail_boite_unifiee: { tous: 2_000, lit: async (s) => (await mailApi(s, `/api/veridian/mail.mailboxes.list?workspace_id=${MAIL}`)).status() === 200 },
      mail_imap: { tous: 8_000, lit: (s) => imap(hoteImap, P.email, s.boite) },
      prospection_espaces: { tous: 700, lit: async (s) => (((await (await s.ctx.request.get(`${APP_URL.prospection}/api/me`, { timeout: 15_000 })).json().catch(() => null)) as Json)?.workspaces ?? []).some((w: { id: string }) => w.id === commun) },
      prospection_donnee: { tous: 700, lit: async (s) => (await (await atlas(s, 'lister_segments_atlas', {})).text()).includes(DOSSIER) },
    };
    const noms = Object.keys(PORTES);
    const lire = (x: string, s: Personne) => PORTES[x].lit(s);
    for (const s of tous3) {
      const fermees: string[] = [];
      for (const x of noms) if (!(await lire(x, s).catch(() => false))) fermees.push(x);
      expect(fermees, `contrôle positif, ${s === sP ? 'propriétaire' : s === sM ? 'membre' : 'témoin'} : tout lit avant le retrait`).toEqual([]);
    }
    await creerFiche();
    await expect.poll(() => tous3.map((s) => s.direct.lignes.some((l) => l.texte.includes(fiches[0]?.id ?? '?'))), { timeout: 30_000, message: 'contrôle positif : le flux du CRM reçoit, chez les trois' }).toEqual([true, true, true]);
    expect(tous3.map((s) => s.mail.ouvert()), 'contrôle positif : le flux de Mail est ouvert, chez les trois').toEqual([true, true, true]);

    // Des liens de connexion reçus avant, pas encore ouverts (Mail : 60 s de vie).
    const lienC = await lienCrm(CRM, M);
    const liens = { prospection: await lienRebond(sM.ctx, 'prospection'), notifuse: await lienRebond(sM.ctx, 'notifuse') };
    if (!lienC || !liens.notifuse || !liens.prospection) throw new NonAbouti(`un lien de connexion manque avant le retrait : CRM ${Boolean(lienC)}, Mail ${Boolean(liens.notifuse)}, Prospection ${Boolean(liens.prospection)}`);

    const ret = process.env.SSO_SABOTAGE === 'retrait-session' ? null : await admin<{ apps: { app: string; etat: string; detail?: string }[]; avis?: string | null }>('POST', `tenants/${T.id}/remove-member`, { hub_user_id: M.hubUserId });
    const t0 = Date.now();
    const dernier: Record<string, number> = {};
    const essais: Record<string, number> = {};
    const temoins: Record<string, boolean> = {};
    const noter = (x: string, t: number) => { dernier[x] = Math.max(dernier[x] ?? 0, 1, t - t0); };
    await Promise.all([
      ...noms.map(async (x) => {
        while (Date.now() - t0 < DUREE) {
          const t = Date.now();
          essais[x] = (essais[x] ?? 0) + 1;
          if (await lire(x, sM).catch(() => false)) noter(x, t);
          for (const [qui, s] of [['propriétaire', sP], ['témoin', sW]] as const) if (!(await lire(x, s).catch(() => false)) && !(await lire(x, s).catch(() => false))) temoins[`${x} (${qui})`] = false;
          await pause(PORTES[x].tous);
        }
      }),
      (async () => { while (Date.now() - t0 < DUREE) { await creerFiche(); await pause(4_000); } })(),
      (async () => {
        // Les liens non consommés, ouverts juste après ; s'ils ouvrent une session, elle est sondée jusqu'au bout.
        const c1 = await browser.newContext();
        const c2 = await browser.newContext();
        ouverts.push(c1, c2);
        const [neufs, jm] = await Promise.all([consommer(CRM, lienC), jetonMail(c1, liens.notifuse), (async () => { const p = await c2.newPage(); await p.goto(liens.prospection, { waitUntil: 'domcontentloaded' }).catch(() => undefined); await p.close(); })()]);
        const portes: Record<string, () => Promise<boolean>> = {
          lien_crm: async () => Array.isArray((await graphql(CRM, neufs.acces, COMPAGNIES))?.data?.companies?.edges),
          lien_mail: () => lireMail(jm),
          lien_prospection: async () => (await (await c2.request.post(`${APP_URL.prospection}/api/atlas/lister_segments_atlas`, { data: {}, timeout: 15_000 })).text()).includes(DOSSIER),
        };
        while (Date.now() - t0 < DUREE) {
          for (const [x, f] of Object.entries(portes)) { const t = Date.now(); essais[x] = (essais[x] ?? 0) + 1; if (await f().catch(() => false)) noter(x, t); }
          await pause(1_500);
        }
      })(),
    ]);
    await pause(17_000);
    const apres = fiches.filter((f) => f.t > t0 && f.t - t0 < DUREE);
    const vues = (s: Personne) => apres.filter((f) => s.direct.lignes.some((l) => l.texte.includes(f.id)));
    for (const f of vues(sM)) noter('crm_flux', f.t);
    essais.crm_flux = apres.length;
    for (const [qui, s] of [['propriétaire', sP], ['témoin', sW]] as const) if (apres.length < 5 || vues(s).length !== apres.length) temoins[`crm_flux (${qui}) ${vues(s).length}/${apres.length}`] = false;
    const battus = (s: Personne) => s.mail.lignes.filter((l) => l.t > t0);
    for (const l of battus(sM)) noter('mail_flux', l.t);
    essais.mail_flux = battus(sP).length;
    for (const [qui, s] of [['propriétaire', sP], ['témoin', sW]] as const) if (battus(s).length < 3) temoins[`mail_flux (${qui})`] = false;

    const toutes = [...noms, 'crm_flux', 'mail_flux', 'lien_crm', 'lien_mail', 'lien_prospection'];
    const retrait = ret?.json.apps?.map((x) => `${x.app}=${x.etat}`).join(' ') ?? 'pas joué';
    const perdus = Object.keys(temoins);
    // Le détail, porte par porte, tient dans un fichier : le bilan de la batterie est coupé court.
    writeFileSync(path.join(__dirname, '.run', 'portes-37.json'), JSON.stringify({ le: new Date().toISOString(), sabotage: ret === null, retrait, avis: ret?.json.avis ?? null, temoins_perdus: perdus, portes: Object.fromEntries(toutes.map((x) => [x, { derniere_lecture_ms: dernier[x] ?? 0, essais: essais[x] ?? 0 }])) }, null, 1));
    const ouvertes = toutes.filter((x) => (dernier[x] ?? 0) >= BORNE);
    expect([ouvertes, perdus], `ouvertes après le retrait : ${ouvertes.map((x) => `${x} ${Math.round(dernier[x] / 1000)} s`).join(', ')} ; ${retrait}`).toEqual([[], []]);
    return `${toutes.length} portes fermées, la plus lente ${Math.max(0, ...toutes.map((x) => dernier[x] ?? 0))} ms ; propriétaire et témoin lisent tout du long`;
  } finally {
    for (const f of fermer) f();
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 1_500_000 });
