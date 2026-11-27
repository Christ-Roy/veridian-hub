/**
 * Recette de A à Z (cas 50), étapes de la vie d'une organisation : un membre arrive, le SSO d'organisation s'ouvre (libre, puis obligatoire), le membre est
 * retiré, l'organisation est suspendue puis reprise. Chaque étape est une fonction `(r: Recette) => Promise<string>` du cadre `recette.ts` : un détail court si
 * VRAI, `NonAbouti` si on n'a pas pu mesurer, une `Error` si l'assertion est fausse. Les mesures sont extraites des cas 22, 37, 38, 21, 34, 39, 41 et 46,
 * adaptées à UNE organisation jetable déjà ouverte dans les apps (prod). Comptes e2e-sso-* seulement, aucune adresse ni secret dans un texte rendu.
 *
 * L'étape SSO libre laisse le fournisseur jetable (SAML) ouvert pour l'étape suivante : l'appelant DOIT appeler `fermerCoupures(r)` en fin de recette (finally).
 * Une porte qu'une étape n'a pas pu lire avant le geste (contrôle positif) est « non mesuré », jamais « fermé » : une porte jamais vue ouverte ne prouve rien.
 */
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';

import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

import { membreDe, operateur, organisationDe } from './analytics';
import { APP_URL, HUB_URL, masquer, type AppKey } from './cibles';
import { NonAbouti } from './etat';
import { admin, adminOk, appelAcademy, lookup, secretDe } from './hub-admin';
import { obtenirJetonMcp, outil } from './mcp';
import { COMPAGNIES, consommer, lienCrm, portesCrm, type Porteur } from './portes-crm';
import { adresseDe, creerCompteProuve, ouvrirApp, PAGE_PROTEGEE, voirApp, type Compte } from './parcours';
import type { Recette } from './recette';
import { ouvrirSaml } from './saml-jetable';

const ACADEMY_URL = process.env.ACADEMY_URL || 'https://academy.app.veridian.site';

type Json = any;
type Issue = { app: string; etat: string; detail?: string };
const ORIGINE = { origin: new URL(HUB_URL).origin };
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** Au-delà de cette durée après le geste, une porte encore lue n'est plus une propagation : c'est une porte ouverte. */
const BORNE = 5_000;
const DUREE = 65_000;
const NOM_CLIENT_IA = 'RECETTE COUPURES';

const egal = (reel: unknown, attendu: unknown, quoi: string) => {
  if (JSON.stringify(reel) !== JSON.stringify(attendu)) throw new Error(`${quoi} : ${JSON.stringify(reel)} au lieu de ${JSON.stringify(attendu)}`);
};
const premiere = (e: unknown) => masquer((e instanceof Error ? e.message : String(e)).split('\n')[0]).slice(0, 160);
const surProd = () => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('recette de prod (organisations réglées, apps réelles)');
};

/** L'organisation de la recette, telle que le Hub la lit. */
async function organisation(r: Recette): Promise<{ id: string; slug: string; notifuseWorkspaceSlug?: string }> {
  const t = ((await lookup(r.P.email)).json?.tenants ?? []).find((x: { id: string }) => x.id === r.tenantId);
  if (!t) throw new NonAbouti('organisation de la recette introuvable chez son propriétaire');
  return t;
}

/** Les apps de l'organisation, d'après son document ; à défaut de le lire, les quatre apps à rebond. */
async function appsDe(r: Recette): Promise<AppKey[]> {
  const g = await admin('GET', `organisations/${r.tenantId}`);
  const modules: string[] = g.json?.document?.modules ?? [];
  const t: Record<string, AppKey> = { notifuse: 'notifuse', mail: 'notifuse', prospection: 'prospection', crm: 'twenty', twenty: 'twenty', analytics: 'analytics' };
  const lues = Array.from(new Set(modules.map((m) => t[m]).filter(Boolean)));
  return lues.length ? lues : ['notifuse', 'prospection', 'twenty', 'analytics'];
}

/** Analytics : l'opérateur et l'organisation Analytics de la recette (valeur posée par l'étape d'ouverture si elle existe). */
async function analyticsDe(r: Recette): Promise<{ op: APIRequestContext; org: string } | null> {
  try {
    const op = await operateur();
    const org = r.notes.orgAnalytics || (await organisationDe(op, r.P.email));
    return { op, org };
  } catch {
    return null;
  }
}

/**
 * L'organisation de la recette doit être RÉGLÉE (type organisation) AVANT que le membre existe : sinon le premier geste du membre (jeton IA, rebond) lui crée un espace
 * à lui, et il n'est plus un salarié (lib/tenants/membre-seul.ts). Même réglage que les cas 34, 37, 41 et 46 ; déjà réglée, on n'y touche pas.
 */
async function assurerOrganisationReglee(r: Recette): Promise<string> {
  const g = await admin<{ document?: { type?: string } }>('GET', `organisations/${r.tenantId}`);
  if (g.status === 200 && g.json?.document?.type === 'organisation') return 'organisation déjà réglée';
  const p = await admin<{ emissions?: Issue[]; error?: string }>('PUT', `organisations/${r.tenantId}`, { type: 'organisation', nom_affiche: 'TEST RECETTE', modules: ['academy', 'notifuse', 'prospection', 'crm'] });
  if (![200, 207].includes(p.status)) throw new NonAbouti(`organisation non réglée : HTTP ${p.status} ${masquer(JSON.stringify(p.json)).slice(0, 160)}`);
  const pas = (p.json?.emissions ?? []).filter((e) => e.etat !== 'applique');
  if (pas.length) throw new NonAbouti(`organisation réglée, mais ${pas.map((e) => `${e.app}=${e.etat}`).join(' ')}`);
  return 'organisation réglée par la recette';
}

/** Un salarié : membre de l'organisation, sans espace à lui (un espace à lui change son organisation active et rend ses mesures fausses). */
async function verifierSalarie(M: Compte): Promise<void> {
  const mien = ((await lookup(M.email)).json?.tenants ?? []) as { id: string }[];
  if (mien.length) throw new NonAbouti(`le membre a ${mien.length} espace(s) à lui : ce n'est pas un salarié, ses entrées ne prouvent rien sur l'organisation`);
}

/** Les espaces de Prospection qu'une session lit (après son rebond). */
async function espacesProspection(ctx: BrowserContext): Promise<string[]> {
  await ouvrirApp(ctx, 'prospection');
  const me = (await (await ctx.request.get(`${APP_URL.prospection}/api/me`)).json().catch(() => null)) as { workspaces?: { id: string }[] } | null;
  return (me?.workspaces ?? []).map((w) => w.id);
}

/** Une porte ouverte dans un AUTRE espace ne prouve rien : la session du membre doit être dans l'espace de la recette, sinon NON ABOUTI. */
async function verifierEspaceRecette(r: Recette, T: { slug: string }, sP: Tenue, sM: Tenue | null): Promise<void> {
  const ailleurs: string[] = [];
  const hote = r.notes.hoteCrm;
  for (const [qui, s] of [['propriétaire', sP], ['membre', sM]] as const) {
    if (!s) continue;
    if (s.crm && hote && new URL(s.crm.origine).host !== hote) ailleurs.push(`CRM ${qui}`);
    if (s.ia) {
      const slugs = (JSON.parse((await outil(s.ia, 'executer_outil', { nom: 'hub.mon_compte' })).texte).espaces ?? []).map((e: { slug: string }) => e.slug);
      if (!slugs.includes(T.slug)) ailleurs.push(`porte IA ${qui}`);
    }
  }
  if (sM) {
    if (sP.crm && sM.crm && sP.crm.origine !== sM.crm.origine) ailleurs.push('CRM membre (hôte différent du propriétaire)');
    if (sM.espaces.length && (!sM.espaces.some((x) => sP.espaces.includes(x)) || sM.espaces.some((x) => !sP.espaces.includes(x)))) ailleurs.push('Prospection membre (espace hors organisation)');
  }
  if (ailleurs.length) throw new NonAbouti(`session hors de l'espace de la recette : ${ailleurs.join(', ')}`);
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

/** Le geste réel « ouvrir <app> » ; l'anti-boucle du rebond dure 30 s : on repasse après 35 s. */
async function entrerParRebond(ctx: BrowserContext, app: AppKey) {
  let v = await voirApp(ctx, app);
  for (let i = 1; i < 3 && !v.connecte; i++) {
    await pause(35_000);
    v = await voirApp(ctx, app);
  }
  return v;
}

/** Une capture de l'app telle que la personne la voit, sur une page neuve du même contexte. */
async function capturerApp(r: Recette, ctx: BrowserContext, app: AppKey, nom: string) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${APP_URL[app]}${PAGE_PROTEGEE[app]}`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(app === 'twenty' ? 8_000 : 2_000);
    await r.capture(page, nom);
  } finally {
    await page.close();
  }
}

/** État propre aux étapes SSO : le fournisseur jetable et les contextes ouverts vivent d'une étape à l'autre. */
let fournisseur: Awaited<ReturnType<typeof ouvrirSaml>> | null = null;
const ouvertsSso: BrowserContext[] = [];
let jetonDeM: string | null = null;

/** À appeler par la recette en fin de parcours : règle libre, fournisseur retiré, serveur jetable fermé. Jamais d'erreur. */
export async function fermerCoupures(r?: Recette): Promise<void> {
  if (r) {
    await admin('PUT', `organisations/${r.tenantId}/connexion`, { obligatoire: false, aiguillage: [] }).catch(() => undefined);
    await admin('DELETE', `organisations/${r.tenantId}/idp`).catch(() => undefined);
    await admin('POST', `tenants/${r.tenantId}/suspension`, { suspendre: false }).catch(() => undefined);
  }
  await fournisseur?.fermer().catch(() => undefined);
  fournisseur = null;
  for (const c of ouvertsSso.splice(0)) await c.close().catch(() => undefined);
  jetonDeM = null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1. Inviter un membre
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * D'après 22, 41 et 46 : l'organisation est réglée (type organisation) puis le membre naît SANS espace à lui (un salarié, `membre-seul.ts`) ; invitation signée comme Mail la signe, acceptée par le membre avec sa session Hub ; il devient membre au Hub (porte IA) ; puis il entre dans
 * chaque app de l'organisation par le rebond. Pose `r.M`. NON ABOUTI : staging, pas d'espace Mail, secret d'invitation illisible, compte non créé.
 * Porté tel quel : l'invitation par Mail (le seul chemin signé existant). Non porté : le refus d'un simple membre qui invite (403) et l'espace non relié (409),
 * qui exigent un tiers : ils restent au cas 22.
 */
export async function inviterMembre(r: Recette): Promise<string> {
  surProd();
  const T = await organisation(r);
  const mail = T.notifuseWorkspaceSlug;
  if (!mail) throw new NonAbouti('organisation sans espace Mail : le chemin d\'invitation est celui de Mail');
  const secret = secretDe('HUB_INVITATION_SECRET_NOTIFUSE_PROD');
  // Un vrai salarié : l'organisation est réglée d'abord, le membre naît sans espace (comme 41 et 46), et AUCUN geste du membre (jeton IA, rebond) n'a lieu
  // avant son rattachement : c'est ce geste, fait trop tôt, qui lui créait un espace à lui.
  const reglage = await assurerOrganisationReglee(r);
  const M: Compte = r.M ?? (await creerCompteProuve(r.browser, 'recmembre', adresseDe('recmembre'), true));
  r.M = M;
  if (!M.hubUserId) throw new NonAbouti('compte du membre sans identifiant Hub');
  await verifierSalarie(M);
  const espaces = async (): Promise<string[]> => {
    jetonDeM = jetonDeM ?? (await obtenirJetonMcp(r.browser, M, NOM_CLIENT_IA));
    return (JSON.parse((await outil(jetonDeM, 'executer_outil', { nom: 'hub.mon_compte' })).texte).espaces ?? []).map((e: { slug: string }) => e.slug);
  };

  const corps = JSON.stringify({ inviter_user_id: r.P.hubUserId, inviter_email: r.P.email, invitee_email: M.email, target_app: 'notifuse', target_workspace_id: mail, target_role: 'member' });
  const ts = String(Date.now());
  const cree = await fetch(`${HUB_URL}/api/invitations/create`, {
    method: 'POST',
    // vers-le-hub : invitation signée par une app, vérifiée par le Hub (lib/invitations/hmac.ts).
    headers: { 'content-type': 'application/json', 'x-veridian-app': 'notifuse', 'x-veridian-timestamp': ts, 'x-veridian-invitation-signature': createHmac('sha256', secret).update(`${ts}.${corps}`).digest('hex') },
    body: corps,
    signal: AbortSignal.timeout(30_000),
  });
  const jc = (await cree.json().catch(() => null)) as Json;
  if (cree.status !== 201 || !jc?.token) throw new Error(`invitation : création HTTP ${cree.status} ${masquer(JSON.stringify(jc)).slice(0, 160)}`);

  const ctxM = await r.contexte(M);
  try {
    const acc = await ctxM.request.post(`${HUB_URL}/api/invitations/${jc.token}/accept`, { data: {}, headers: ORIGINE });
    const ja = (await acc.json().catch(() => null)) as Json;
    egal([acc.status(), ja?.downstream_call], [200, 'completed'], 'acceptation');
    if (!(await espaces()).includes(T.slug)) throw new Error('invitation acceptée mais le membre n\'est pas dans l\'organisation (porte IA)');
    await verifierSalarie(M);

    // Le tableau de bord du membre, puis chaque app par le vrai rebond.
    const accueil = await ctxM.newPage();
    await accueil.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' }).catch(() => undefined);
    await r.capture(accueil, 'membre-tableau-de-bord');
    await accueil.close();

    const apps = await appsDe(r);
    const an = apps.includes('analytics') ? await analyticsDe(r) : null;
    const etats: string[] = [];
    const refus: string[] = [];
    const ailleurs: string[] = [];
    const hoteCrm = r.notes.hoteCrm;
    const espacesP = apps.includes('prospection') ? await (async () => { const cp = await r.contexte(r.P); try { return await espacesProspection(cp); } finally { await cp.close(); } })() : [];
    try {
      if (an) await membreDe(an.op, an.org, M.email).catch(() => undefined);
      for (const app of apps) {
        if (app === 'analytics' && !an) { etats.push('analytics=non mesuré (organisation Analytics illisible)'); continue; }
        const v = await entrerParRebond(ctxM, app);
        etats.push(`${app}=${v.connecte ? 'entré' : 'refusé'}`);
        if (!v.connecte) refus.push(`${app} (${v.hote}${v.chemin})`);
        if (v.connecte && app === 'twenty' && hoteCrm && v.hote !== hoteCrm) ailleurs.push(`CRM (${v.hote})`);
        if (v.connecte && app === 'prospection') {
          const siens = await espacesProspection(ctxM);
          if (!siens.length || siens.some((x) => !espacesP.includes(x))) ailleurs.push('Prospection (espace hors organisation)');
        }
        await capturerApp(r, ctxM, app, `membre-${app}`);
      }
    } finally {
      await an?.op.dispose();
    }
    r.notes.membreInvite = '1';
    if (ailleurs.length) throw new NonAbouti(`le membre entre dans un autre espace que celui de la recette : ${ailleurs.join(', ')} ; ${etats.join(' ')}`);
    if (refus.length) throw new Error(`le membre n'entre pas : ${refus.join(', ')} ; ${etats.join(' ')}`);
    if (etats.some((e) => e.includes('non mesuré'))) throw new NonAbouti(`membre dans l'organisation, mais ${etats.join(' ')}`);
    return `${reglage}, membre sans espace à lui ; invitation Mail acceptée (completed), membre à l'organisation ; ${etats.join(' ')}`;
  } finally {
    await ctxM.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2. SSO d'organisation en libre service
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * D'après 41 (SAML, posé à l'écran : c'est le seul fournisseur qui se pose au libre-service) et 39 (le membre relie le sien et entre, session bornée).
 * Le propriétaire colle émetteur, adresse et certificat sur l'écran Organisation, essaie, active ; fermé avant l'essai, même forcé ; un membre relie le sien,
 * entre par la porte de l'organisation (session fédérée), les 13 réponses fausses du fournisseur sont refusées. Le fournisseur RESTE actif (étape 3).
 * NON ABOUTI : staging, pas de membre (étape 1), `tailscale` illisible, le navigateur n'atteint pas le fournisseur jetable.
 * Non porté : OIDC RS256 à la façon Infomaniak (39), qui se pose par l'API admin et demande que LE HUB atteigne le serveur jetable ; la seconde organisation et
 * la liaison volée (sub déjà pris) exigent un deuxième compte et une deuxième organisation. La coupure à l'écran (41) est laissée à `fermerCoupures`.
 */
export async function ssoLibre(r: Recette): Promise<string> {
  surProd();
  const T = await organisation(r);
  const M = r.M;
  if (!M) throw new NonAbouti('pas de membre : l\'étape d\'invitation n\'a pas abouti');
  let ip: string;
  try {
    ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    throw new NonAbouti('adresse tailscale illisible : le fournisseur jetable ne peut pas s\'ouvrir');
  }
  if (fournisseur) await fournisseur.fermer().catch(() => undefined);
  const idp = (fournisseur = await ouvrirSaml(ip));
  const ctxDe = async (c?: Compte) => {
    const x = await r.browser.newContext({ ...(c ? { storageState: c.etat as never } : {}), viewport: { width: 1280, height: 900 } });
    x.setDefaultTimeout(45_000);
    ouvertsSso.push(x);
    return x;
  };
  const session = async (c: BrowserContext) => ((await (await c.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: { email?: string; federe?: boolean } } | null)?.user ?? null;
  /** Par la porte de l'organisation, navigateur neuf. */
  const entrer = async (sub: string, mensonge: Parameters<typeof idp.mentir>[0] = null, garder = true) => {
    idp.dire(sub);
    idp.mentir(mensonge);
    const ctx = await ctxDe();
    const p = await ctx.newPage();
    await p.goto(`${HUB_URL}/connexion/${T.slug}`, { waitUntil: 'networkidle' });
    await p.waitForURL((u) => u.origin === new URL(HUB_URL).origin).catch(() => undefined);
    await p.waitForLoadState('networkidle');
    const x = { ctx, chemin: new URL(p.url()).pathname, texte: (await p.locator('body').innerText()).slice(0, 1_500), email: (await session(ctx))?.email?.toLowerCase() ?? null, federe: (await session(ctx))?.federe };
    await p.close();
    idp.mentir(null);
    if (!garder) await ctx.close().catch(() => undefined);
    return x;
  };

  const prop = await ctxDe(r.P);
  const page = await prop.newPage();
  const ecran = async () => {
    await page.goto(`${HUB_URL}/dashboard/organisation`, { waitUntil: 'networkidle' });
    await page.getByText('Se connecter avec le compte de votre organisation').click();
  };
  await ecran();
  await page.getByText('SAML 2.0', { exact: true }).click();
  await page.getByLabel("Identifiant d'entité du fournisseur").fill(idp.issuer);
  await page.getByLabel('Adresse de connexion (SSO)').fill(idp.sso);
  await page.getByLabel('Certificat de signature (X.509)').fill(idp.certificat);
  await page.locator('form', { has: page.getByLabel('Certificat de signature (X.509)') }).getByRole('button', { name: 'Enregistrer' }).click();
  await page.waitForURL(/avis=/);
  const avis = await page.getByRole('status').first().innerText();
  if (!avis.includes('Fournisseur enregistré')) throw new Error(`pose du fournisseur à l'écran : ${masquer(avis).slice(0, 120)}`);
  await r.capture(page, 'organisation-fournisseur-pose');

  // Posé, jamais essayé : fermé, aucun bouton pour l'ouvrir, et forcé sans l'écran il refuse.
  const avant = await entrer('s-1', null, false);
  egal([avant.chemin, idp.demandes()], ['/login', 0], 'avant l\'essai');
  await ecran();
  egal(await page.getByRole('button', { name: 'Activer' }).count(), 0, 'bouton Activer avant l\'essai');
  const force = await prop.request.post(`${HUB_URL}/api/organisations/fournisseur`, { headers: ORIGINE, form: { tenant: T.id, geste: 'activer' }, maxRedirects: 0 });
  if (!(force.headers().location ?? '').includes('essai_manquant')) throw new Error('activation forcée sans essai : pas refusée par essai_manquant');

  idp.dire('sub-proprietaire');
  await page.getByRole('button', { name: 'Essayer' }).click();
  await page.waitForURL((u) => u.origin === new URL(HUB_URL).origin && /avis=|federation/.test(`${u.pathname}${u.search}`)).catch(() => undefined);
  if (/ne répond pas/.test(await page.locator('body').innerText())) throw new NonAbouti(`le navigateur n'atteint pas le fournisseur jetable (${ip})`);
  if (!new URL(page.url()).search.includes('essai_reussi')) throw new Error(`essai du propriétaire : ${masquer(await page.locator('body').innerText()).slice(0, 160)}`);
  await ecran();
  await page.getByRole('button', { name: 'Activer' }).click({ timeout: 10_000 });
  await page.waitForURL(/fournisseur_actif/);
  await page.getByText('Se connecter avec le compte de votre organisation').click();
  await r.capture(page, 'organisation-fournisseur-actif');
  await page.close();

  // Actif : personne n'est relié, l'essai n'a relié personne.
  const demandesAvant = idp.demandes();
  const sonde = await entrer('sub-proprietaire', null, false);
  egal([sonde.email, /pas encore relié/.test(sonde.texte)], [null, true], 'actif, personne reliée');
  if (idp.demandes() <= demandesAvant) throw new Error('la porte de l\'organisation n\'a pas interrogé le fournisseur');

  // Le membre relie le sien par le bouton, puis entre.
  const mem = await ctxDe(M);
  const pm = await mem.newPage();
  idp.dire('sub-membre');
  await pm.goto(`${HUB_URL}/dashboard/settings`, { waitUntil: 'networkidle' });
  await pm.getByRole('button', { name: /^Relier mon compte/ }).click({ timeout: 20_000 });
  await pm.waitForURL((u) => u.origin === new URL(HUB_URL).origin && /federation/.test(`${u.pathname}${u.search}`)).catch(() => undefined);
  if (new URL(pm.url()).search !== '?federation=reliee') throw new Error(`liaison du membre : ${masquer(new URL(pm.url()).search)} ${masquer((await pm.locator('body').innerText()).slice(0, 160))}`);
  await pm.close();
  const un = await entrer('sub-membre');
  egal([un.email, un.chemin, un.federe], [M.email.toLowerCase(), '/dashboard', true], `entrée du membre par le fournisseur (${masquer(un.texte).slice(0, 80)})`);
  const regle = await un.ctx.request.post(`${HUB_URL}/api/organisations/fournisseur`, { headers: ORIGINE, form: { tenant: T.id, geste: 'couper' }, maxRedirects: 0 });
  egal(regle.status(), 403, 'une session fédérée ne règle rien');

  // Tout ce qu'un fournisseur fausse est refusé.
  const faux = ['signature', 'sans_signature', 'audience', 'emetteur', 'expire', 'autre_demande', 'sans_demande', 'sha1', 'adresse', 'ephemere', 'deux_assertions', 'commentaire', 'apres_signature'] as const;
  const passes: string[] = [];
  for (const f of faux) if ((await entrer('sub-membre', f, false)).email) passes.push(f);
  egal(passes, [], 'réponses fausses qui ont ouvert');
  // La connexion habituelle du membre vit toujours.
  egal((await session(mem))?.email?.toLowerCase(), M.email.toLowerCase(), 'témoin : sa connexion habituelle');
  const ecranFinal = await (await ctxDe(r.P)).newPage();
  await ecranFinal.goto(`${HUB_URL}/dashboard/organisation`, { waitUntil: 'networkidle' });
  await r.capture(ecranFinal, 'organisation-ecran');
  await ecranFinal.close();
  r.notes.ssoActif = '1';
  return `SAML posé à l'écran, fermé avant l'essai (forcé : essai_manquant), essayé, activé ; membre relié, entré par la porte (session fédérée, ne règle rien) ; ${faux.length} réponses fausses refusées ; sa connexion habituelle vit`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 3. Connexion obligatoire (puis retour au libre)
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * D'après 46 : six portes (rebond vers Prospection, porte IA, choix d'organisation, écran Organisation, assistant, échange entre apps) mesurées pour le membre
 * par mot de passe. Libre : six ouvertes (contrôle positif). Obligatoire : six fermées ; le propriétaire (accès de secours) garde l'écran ; une AUTRE session du
 * membre reste fermée ; le membre passé par le fournisseur rouvre tout, avec un jeton d'IA neuf (l'ancien reste fermé). Puis la règle est remise LIBRE et les six
 * portes rouvrent par mot de passe. NON ABOUTI : staging, étapes 1 ou 2 non abouties, pas de jeton d'IA. « Échange » est « non lu » (donc exclu des deux côtés,
 * dit dans le détail) si aucune poignée de délégation n'est émise.
 * Non porté : la seconde organisation du membre (« l'autre reste ouverte »), les accès gardés par rattachement, l'aiguillage par domaine et la page de connexion
 * (il faut un deuxième compte, une deuxième organisation et un domaine d'aiguillage inventé) ; une session par Google (aucun compte d'épreuve). Cas 46.
 */
export async function ssoObligatoire(r: Recette): Promise<string> {
  surProd();
  const T = await organisation(r);
  const M = r.M;
  const idp = fournisseur;
  if (!M?.hubUserId) throw new NonAbouti('pas de membre : l\'étape d\'invitation n\'a pas abouti');
  if (!idp || r.notes.ssoActif !== '1') throw new NonAbouti('fournisseur absent : l\'étape SSO libre n\'a pas abouti');
  const regle = `organisations/${T.id}/connexion`;
  const ouverts: BrowserContext[] = [];
  const navigateur = async (c: Compte) => {
    const ctx = await r.browser.newContext({ storageState: c.etat as never, viewport: { width: 1280, height: 1000 } });
    ctx.setDefaultTimeout(45_000);
    ouverts.push(ctx);
    return ctx;
  };
  const ou = async (ctx: BrowserContext, url: string) => {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => undefined);
    const u = new URL(page.url());
    const x = { chemin: u.pathname, texte: (await page.locator('body').innerText().catch(() => '')).slice(0, 1_500), html: await page.content().catch(() => '') };
    await page.close();
    return x;
  };
  const rebond = (ctx: BrowserContext) => ou(ctx, `${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL.prospection}/`)}`);
  const mcp = async (jeton: string) => (await outil(jeton, 'executer_outil', { nom: 'hub.integrations_lister', espace: T.slug })).isError;
  const activer = async (ctx: BrowserContext) => (await ctx.request.post(`${HUB_URL}/api/organisations/active`, { headers: ORIGINE, form: { tenant: T.id }, maxRedirects: 0 })).headers().location ?? '';
  const fil = async (ctx: BrowserContext) => (await ctx.request.get(`${HUB_URL}/api/ia/fil?app=academy&session=00000000-0000-4000-8000-000000000000&tenant=${T.id}`)).status();
  const grant = (await admin<{ delegations?: { hub_tenant_id: string; grant: string }[] }>('POST', 'delegation/poignee', { email: M.email, app: 'prospection' })).json?.delegations?.find((d) => d.hub_tenant_id === T.id)?.grant;
  const echanger = async (): Promise<string> => {
    const c = JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_grant: grant, audience: 'crm', scope: 'crm:societe.ecrire crm:tache.ecrire' });
    const [ts, nonce] = [String(Date.now()), randomBytes(18).toString('base64url')];
    // vers-le-hub : jeton de délégation signé par une app, vérifié par le Hub (lib/delegation/jeton.ts).
    const x = await fetch(`${HUB_URL}/api/delegation/jeton`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-veridian-app': 'prospection', 'x-veridian-timestamp': ts, 'x-veridian-nonce': nonce, 'x-veridian-hub-signature': createHmac('sha256', secretDe('PROSPECTION_TENANT_API_SECRET')).update(`${ts}.${nonce}.${c}`).digest('hex') }, body: c, signal: AbortSignal.timeout(30_000) });
    return ((await x.json().catch(() => null)) as { error?: string } | null)?.error ?? 'ok';
  };
  type Porte = 'rebond' | 'mcp' | 'choix' | 'ecran' | 'assistant' | 'echange';
  const portes = async (ctx: BrowserContext, jeton: string): Promise<Record<string, 'ouverte' | 'fermée'>> => {
    const p: Record<string, 'ouverte' | 'fermée'> = {
      rebond: (await rebond(ctx)).chemin === '/auth/organisation' ? 'fermée' : 'ouverte',
      mcp: (await mcp(jeton)) ? 'fermée' : 'ouverte',
      choix: /avis=active/.test(await activer(ctx)) ? 'ouverte' : 'fermée',
      assistant: (await fil(ctx)) === 404 ? 'fermée' : 'ouverte',
    };
    if (grant) p.echange = (await echanger()) === 'organisation_fournisseur' ? 'fermée' : 'ouverte';
    // « écran » : le cas 46 lit l'identifiant de l'organisation dans le sélecteur de /dashboard/organisation, qu'il n'y a que pour une personne
    // de PLUSIEURS organisations. Pour un salarié d'une seule, la page dit la même chose ouverte ou fermée : porte non mesurable, écartée et
    // dite (26/11, mesurée à tort « fermée » en libre). Le cas 46 la garde.
    return p;
  };
  const toutes = (x: 'ouverte' | 'fermée'): Record<string, string> => Object.fromEntries((['rebond', 'mcp', 'choix', 'assistant', ...(grant ? ['echange'] : [])] as Porte[]).map((k) => [k, x]));
  const passer = async (ctx: BrowserContext, sub: string): Promise<string> => {
    idp.dire(sub);
    await ctx.clearCookies({ name: /veridian-next/ });
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/auth/organisation?org=${T.id}`, { waitUntil: 'load' });
    await page.getByRole('button', { name: /^Continuer avec/ }).click();
    await page.waitForURL((u) => u.origin === new URL(HUB_URL).origin && !/\/api\/auth\/federation|\/auth\/organisation/.test(u.pathname)).catch(() => undefined);
    await page.waitForLoadState('load').catch(() => undefined);
    const u = new URL(page.url());
    await page.close();
    return `${u.pathname}${u.search}`;
  };

  try {
    const [cm, cp] = [await navigateur(M), await navigateur(r.P)];
    jetonDeM = await obtenirJetonMcp(r.browser, M, NOM_CLIENT_IA);
    const jetonAvant = jetonDeM;

    // Contrôle positif : libre, la même session ouvre tout.
    egal(await portes(cm, jetonAvant), toutes('ouverte'), 'libre : la même session ouvre tout');
    egal((await admin('POST', regle, { hub_user_id: r.P.hubUserId, nature: 'secours' })).status, 200, 'accès de secours du propriétaire');
    const pose = await admin<{ obligatoire: boolean; personnes: { hub_user_id: string; acces: string }[] }>('PUT', regle, { obligatoire: true });
    const acces = (c: Compte) => pose.json?.personnes?.find((p) => p.hub_user_id === c.hubUserId)?.acces;
    egal([pose.status, pose.json?.obligatoire, acces(r.P), acces(M)], [200, true, 'secours', 'fournisseur'], 'règle obligatoire posée');

    const org = await cp.newPage();
    await org.goto(`${HUB_URL}/dashboard/organisation`, { waitUntil: 'load' });
    await org.locator('section[aria-label="Connexion"]').first().scrollIntoViewIfNeeded().catch(() => undefined);
    await r.capture(org, 'organisation-connexion-obligatoire');
    await org.close();

    // Obligatoire : session par mot de passe, chaque porte fermée ; le propriétaire (secours) garde l'écran.
    // L'échange entre apps se fait SANS session : le dernier passage de la personne par le fournisseur fait foi (lib/delegation/jeton.ts,
    // preuve « personne », SESSION_FEDEREE_MAX_S). Le membre y est passé à l'étape 18 : l'échange reste ouvert, par conception (26/11,
    // lu à tort comme une fuite). Les portes à session, elles, se ferment pour une session par mot de passe.
    egal(await portes(cm, jetonAvant), { ...toutes('fermée'), ...(grant ? { echange: 'ouverte' } : {}) }, 'obligatoire, session par mot de passe (échange : passage récent par le fournisseur)');
    const demande = await cm.newPage();
    await demande.goto(`${HUB_URL}/dashboard`, { waitUntil: 'load' }).catch(() => undefined);
    const texteDemande = await demande.locator('body').innerText().catch(() => '');
    await r.capture(demande, 'membre-demande-fournisseur');
    egal([new URL(demande.url()).pathname, /Continuer avec/.test(texteDemande)], ['/auth/organisation', true], 'écran de demande du membre');
    await demande.close();
    egal((await ou(cp, `${HUB_URL}/dashboard`)).chemin, '/dashboard', 'l\'accès de secours ouvre');
    const dernier = await admin('DELETE', regle, { hub_user_id: r.P.hubUserId });
    egal(dernier.json, { error: 'dernier_secours' }, 'dernier accès de secours');

    // Elle passe par le fournisseur : sa session reste la sienne, l'ancien jeton d'IA reste fermé, un neuf ouvre tout.
    egal(await passer(cm, 'sub-membre'), '/dashboard', 'passage par le fournisseur');
    const s = (await (await cm.request.get(`${HUB_URL}/api/auth/session`)).json())?.user as { email?: string } | undefined;
    egal(s?.email?.toLowerCase(), M.email.toLowerCase(), 'sa session à elle');
    egal(await mcp(jetonAvant), true, 'jeton d\'IA donné avant le passage');
    const jetonNeuf = await obtenirJetonMcp(r.browser, { etat: await cm.storageState() }, NOM_CLIENT_IA);
    egal(await portes(cm, jetonNeuf), toutes('ouverte'), 'passée par le fournisseur');
    // Une AUTRE session du même membre, par mot de passe, ne l'ouvre pas : la preuve est de la session, pas du compte.
    const cm2 = await navigateur(M);
    egal((await rebond(cm2)).chemin, '/auth/organisation', 'une autre session, sans passage');

    // Retour arrière : une commande, tout rouvre par mot de passe.
    egal((await admin('PUT', regle, { obligatoire: false, aiguillage: [] })).status, 200, 'retour au libre');
    egal(await portes(cm2, jetonAvant), toutes('ouverte'), 'libre de nouveau, par mot de passe');
    const fin = await cp.newPage();
    await fin.goto(`${HUB_URL}/dashboard/organisation`, { waitUntil: 'load' });
    await r.capture(fin, 'organisation-retour-libre');
    await fin.close();
    jetonDeM = jetonAvant;
    r.notes.connexion = 'libre';
    return `libre : ${Object.keys(toutes('ouverte')).length} portes ouvertes ; obligatoire : portes à session fermées par mot de passe (échange ouvert par le passage récent au fournisseur), secours du propriétaire tenu (dernier secours refusé), passage par le fournisseur : toutes ouvertes, ancien jeton d'IA et autre session fermés ; remis LIBRE : tout rouvre${grant ? '' : ' (échange entre apps non lu : aucune poignée)'}`;
  } finally {
    await admin('PUT', regle, { obligatoire: false, aiguillage: [] }).catch(() => undefined);
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Portes communes aux étapes 4 et 5 : ce qu'une personne tient dans chaque app, lu par les vrais chemins
// ---------------------------------------------------------------------------------------------------------------------------------------------

type Tenue = {
  c: Compte;
  ctx: BrowserContext;
  crm?: Porteur & { origine: string };
  jetonMail?: string;
  espaces: string[];
  ia?: string;
  /** App → raison pour laquelle l'entrée n'a pas pu être faite (porte non lisible). */
  raisons: Record<string, string>;
};
type Porte = { groupe: string; nom: string; tous: number; lit: (s: Tenue) => Promise<boolean> };

async function tenir(r: Recette, c: Compte, apps: AppKey[], ouverts: BrowserContext[], an: { org: string } | null): Promise<Tenue> {
  const ctx = await r.contexte(c);
  ouverts.push(ctx);
  const t: Tenue = { c, ctx, espaces: [], raisons: {} };
  const essayer = async (app: string, f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      t.raisons[app] = premiere(e);
    }
  };
  if (apps.includes('twenty')) {
    await essayer('CRM', async () => {
      let origine = '';
      let lu = false;
      for (let i = 0; i < 3 && !lu; i++) {
        origine = new URL((await ouvrirApp(ctx, 'twenty')).url).origin;
        for (let k = 0; k < 10 && !lu; k++) {
          const x = await ctx.request.post(`${origine}/graphql`, { headers: { origin: origine, 'x-twenty-session-cookie': '1' }, data: { query: COMPAGNIES }, timeout: 15_000 }).catch(() => null);
          lu = Boolean(((await x?.json().catch(() => null)) as Json)?.data?.companies);
          if (!lu) await pause(2_000);
        }
      }
      const { acces, long } = await consommer(origine, await lienCrm(origine, c));
      if (!lu || !acces || !long) throw new Error(`entrée CRM incomplète (session ${lu}, jeton ${Boolean(acces)}, rafraîchissement ${Boolean(long)})`);
      t.crm = { origine, acces, long };
    });
  }
  if (apps.includes('prospection')) {
    await essayer('Prospection', async () => {
      let me: { workspaces?: { id: string }[] } | null = null;
      for (let i = 0; i < 3 && !me?.workspaces?.length; i++) {
        if (i) await pause(35_000);
        await ouvrirApp(ctx, 'prospection');
        me = await (await ctx.request.get(`${APP_URL.prospection}/api/me`)).json().catch(() => null);
      }
      t.espaces = (me?.workspaces ?? []).map((w) => w.id);
      if (!t.espaces.length) throw new Error('aucun espace lu dans Prospection');
    });
  }
  if (apps.includes('notifuse')) {
    await essayer('Mail', async () => {
      const j = await jetonMail(ctx, `${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL.notifuse}/console/`)}`);
      if (!j) throw new Error('aucun jeton de session Mail');
      t.jetonMail = j;
    });
  }
  if (apps.includes('analytics')) {
    await essayer('Analytics', async () => {
      if (!an) throw new Error('organisation Analytics illisible');
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        if (i) await pause(35_000);
        await ouvrirApp(ctx, 'analytics');
        ok = (await ctx.request.get(`${APP_URL.analytics}/api/organizations/${an.org}/sites`)).status() === 200;
      }
      if (!ok) throw new Error('la session n\'ouvre pas la liste des sites');
    });
  }
  await essayer('Porte MCP', async () => {
    t.ia = await obtenirJetonMcp(r.browser, c, NOM_CLIENT_IA);
  });
  return t;
}

function construirePortes(T: { slug: string; notifuseWorkspaceSlug?: string }, apps: AppKey[], origineCrm: string, communs: string[], an: { org: string } | null, academy = false): Porte[] {
  const MAIL = T.notifuseWorkspaceSlug ?? '';
  // Lue = un corps JSON sans erreur, jamais le seul 200 (27/11).
  const mailApi = async (s: Tenue, chemin: string) => { if (!s.jetonMail) return false; const r = await fetch(`${APP_URL.notifuse}${chemin}`, { headers: { Authorization: `Bearer ${s.jetonMail}` }, signal: AbortSignal.timeout(15_000) }); const j = (await r.json().catch(() => null)) as Record<string, unknown> | null; return r.status === 200 && j !== null && !('error' in j); };
  const ia = async (s: Tenue, nom: string, args: object) => {
    if (!s.ia) return false;
    const x = await outil(s.ia, 'executer_outil', { nom, arguments: args, espace: T.slug });
    return !x.isError && !/inconnu pour ce compte|suspendu/.test(x.texte);
  };
  const p: Porte[] = [];
  if (apps.includes('notifuse')) {
    p.push({ groupe: 'Mail', nom: 'mail_session', tous: 700, lit: (s) => mailApi(s, `/api/contacts.list?workspace_id=${MAIL}&limit=1`) });
    p.push({ groupe: 'Mail', nom: 'mail_boite_unifiee', tous: 2_000, lit: (s) => mailApi(s, `/api/veridian/mail.mailboxes.list?workspace_id=${MAIL}`) });
  }
  if (apps.includes('twenty') && origineCrm) {
    p.push({
      groupe: 'CRM',
      nom: 'crm_cookie',
      tous: 700,
      lit: async (s) => Array.isArray(((await (await s.ctx.request.post(`${origineCrm}/graphql`, { headers: { origin: origineCrm, 'x-twenty-session-cookie': '1' }, data: { query: COMPAGNIES }, timeout: 15_000 })).json().catch(() => null)) as Json)?.data?.companies?.edges),
    });
    for (const [nom, d] of Object.entries(portesCrm(origineCrm))) p.push({ groupe: 'CRM', nom, tous: d.tous, lit: async (s) => (s.crm ? d.lit(s.crm) : false) });
  }
  if (apps.includes('prospection')) {
    p.push({ groupe: 'Prospection', nom: 'prospection_espaces', tous: 700, lit: async (s) => (((await (await s.ctx.request.get(`${APP_URL.prospection}/api/me`, { timeout: 15_000 })).json().catch(() => null)) as Json)?.workspaces ?? []).some((w: { id: string }) => communs.includes(w.id)) });
  }
  if (apps.includes('analytics') && an) {
    p.push({ groupe: 'Analytics', nom: 'analytics_sites', tous: 700, lit: async (s) => { const r = await s.ctx.request.get(`${APP_URL.analytics}/api/organizations/${an.org}/sites`, { timeout: 15_000 }); const j = await r.json().catch(() => null); return r.status() === 200 && j !== null && !(typeof j === 'object' && 'error' in (j as object)); } });
  }
  // Academy (parente, 26/11 : sa réserve laisse passer les organisations e2e, 91df9a2). Un espace suspendu y est en LECTURE SEULE, avec le
  // bandeau « Cet espace est suspendu » : la porte est fermée si le rebond du Hub est refusé ou si le bandeau s'affiche. Relue toutes les
  // 31 s : le rebond a un anti-boucle de 30 s par app.
  if (academy) {
    p.push({
      groupe: 'Academy',
      nom: 'academy_espace',
      tous: 31_000,
      lit: async (s) => {
        const page = await s.ctx.newPage();
        try {
          await page.goto(`${HUB_URL}/login?next=${encodeURIComponent(`${ACADEMY_URL}/`)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
          return page.url().startsWith(ACADEMY_URL) && !/Cet espace est suspendu/.test(await page.content().catch(() => ''));
        } finally {
          await page.close();
        }
      },
    });
  }
  if (apps.includes('twenty')) p.push({ groupe: 'Porte MCP', nom: 'ia_crm', tous: 6_000, lit: (s) => ia(s, 'twenty.find_many_people', { limit: 1, select: ['id'] }) });
  if (apps.includes('notifuse')) p.push({ groupe: 'Porte MCP', nom: 'ia_mail', tous: 6_000, lit: (s) => ia(s, 'notifuse.contacts_list', { limit: 1 }) });
  if (apps.includes('prospection')) p.push({ groupe: 'Porte MCP', nom: 'ia_prospection', tous: 6_000, lit: (s) => ia(s, 'prospection.lister_segments_atlas', {}) });
  return p;
}

/** Contrôle positif : une porte jamais vue ouverte (pour la cible ET le témoin) ne mesure rien. */
async function controlePositif(portes: Porte[], personnes: Tenue[]): Promise<{ mesurees: Porte[]; nonLues: string[] }> {
  const mesurees: Porte[] = [];
  const nonLues: string[] = [];
  for (const x of portes) {
    let ouvert = true;
    for (const s of personnes) {
      let lu = false;
      for (let i = 0; i < 2 && !lu; i++) lu = await x.lit(s).catch(() => false);
      if (!lu) ouvert = false;
    }
    if (ouvert) mesurees.push(x);
    else nonLues.push(x.nom);
  }
  return { mesurees, nonLues };
}

/** Chaque porte pendant `DUREE` : la dernière lecture de la cible (ms après le geste), et ce que le témoin a perdu. */
async function sonder(portes: Porte[], cible: Tenue, temoin: Tenue | null): Promise<{ dernier: Record<string, number>; perdus: string[] }> {
  const t0 = Date.now();
  const dernier: Record<string, number> = {};
  const perdus = new Set<string>();
  await Promise.all(
    portes.map(async (x) => {
      while (Date.now() - t0 < DUREE) {
        const t = Date.now();
        if (await x.lit(cible).catch(() => false)) dernier[x.nom] = Math.max(1, t - t0);
        if (temoin && !(await x.lit(temoin).catch(() => false)) && !(await x.lit(temoin).catch(() => false))) perdus.add(x.nom);
        await pause(x.tous);
      }
    }),
  );
  return { dernier, perdus: Array.from(perdus) };
}

type Verdict = { groupe: string; etat: 'fermé' | 'encore ouvert' | 'non mesuré'; texte: string };

/** Une ligne par app : fermé (toutes ses portes lues fermées), encore ouvert (une porte lue après la borne), non mesuré (aucune porte lue au contrôle positif). */
function bilan(attendus: string[], portes: Porte[], mesurees: Porte[], nonLues: string[], dernier: Record<string, number>, raisons: Record<string, string>): Verdict[] {
  return attendus.map((g) => {
    const siennes = portes.filter((x) => x.groupe === g);
    const lues = mesurees.filter((x) => x.groupe === g);
    const manque = siennes.filter((x) => nonLues.includes(x.nom)).map((x) => x.nom);
    if (!lues.length) return { groupe: g, etat: 'non mesuré', texte: `${g}=non mesuré (${raisons[g] ?? (siennes.length ? `portes non lues avant le geste : ${manque.join(', ')}` : 'aucune porte')})` };
    const ouvertes = lues.filter((x) => (dernier[x.nom] ?? 0) >= BORNE);
    if (ouvertes.length) return { groupe: g, etat: 'encore ouvert', texte: `${g}=encore ouvert (${ouvertes.map((x) => `${x.nom} ${Math.round(dernier[x.nom] / 1000)} s`).join(', ')})` };
    const plus = Math.max(0, ...lues.map((x) => dernier[x.nom] ?? 0));
    return { groupe: g, etat: 'fermé', texte: `${g}=fermé (${lues.length} porte(s), dernière lecture ${plus} ms${manque.length ? `, non lues : ${manque.join(', ')}` : ''})` };
  });
}

/** Rend le détail ; une porte ouverte = Error ; un manque de mesure (hors Academy, dit à part) = NonAbouti. */
function conclure(quoi: string, v: Verdict[], supplement: string[]): string {
  const detail = [...v.map((x) => x.texte), ...supplement].join(' ; ');
  const ouvert = v.filter((x) => x.etat === 'encore ouvert');
  if (ouvert.length) throw new Error(`${quoi} : encore ouvert : ${ouvert.map((x) => x.groupe).join(', ')}. ${detail}`);
  if (supplement.some((x) => x.includes('encore ouvert'))) throw new Error(`${quoi} : ${detail}`);
  if (v.some((x) => x.etat === 'non mesuré')) throw new NonAbouti(`${quoi} : rien d'ouvert, mais ${v.filter((x) => x.etat === 'non mesuré').map((x) => x.groupe).join(', ')} non mesuré. ${detail}`);
  return detail;
}

const GROUPES: Record<AppKey, string> = { notifuse: 'Mail', twenty: 'CRM', prospection: 'Prospection', analytics: 'Analytics' };

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 4. Retrait du membre
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * D'après 37, 38 et 21 : le membre et le propriétaire (témoin) lisent chaque porte avant ; le membre est retiré (`remove-member`) ; chaque porte est sondée 65 s,
 * le propriétaire doit tout lire du long. Portes : Mail (session, boîte unifiée, lien non consommé), CRM (cookie, jeton, REST, identité, MCP, rafraîchissement, lien non
 * consommé), Prospection (espaces de l'organisation, lien non consommé), Analytics (session), porte MCP du Hub (CRM, Mail, Prospection), Academy (le Hub dit « retire »
 * et un rejeu de synchronisation est refusé 409). Rend app par app fermé / encore ouvert / non mesuré ; « encore ouvert » = FAUX.
 * NON ABOUTI : membre absent ou non invité, aucune porte lue pour une app, ou Academy/Analytics non lisibles (dit app par app).
 * Non porté (cas 37) : IMAP de boîte et flux en direct (CRM, Mail), accès de boîte créés par le membre, donnée de dossier de Prospection ; (38) clé personnelle REST/MCP
 * d'Analytics et visites (exigent la création d'un site de test) ; (21) la réconciliation et le rejeu du retrait ; le refus de retirer le propriétaire reste au cas 21.
 */
export async function retraitMembre(r: Recette): Promise<string> {
  surProd();
  const T = await organisation(r);
  const M = r.M;
  if (!M) throw new NonAbouti('pas de membre : l\'étape d\'invitation n\'a pas abouti');
  if (!M.hubUserId) throw new NonAbouti('compte du membre sans identifiant Hub');
  const apps = await appsDe(r);
  const an0 = apps.includes('analytics') ? await analyticsDe(r) : null;
  const ouverts: BrowserContext[] = [];
  try {
    const [sP, sM] = [await tenir(r, r.P, apps, ouverts, an0), await tenir(r, M, apps, ouverts, an0)];
    await verifierSalarie(M);
    await verifierEspaceRecette(r, T, sP, sM);
    const communs = sM.espaces.filter((x) => sP.espaces.includes(x));
    const raisons: Record<string, string> = {};
    for (const g of Object.values(GROUPES).concat('Porte MCP')) {
      const rs = [sP.raisons[g] && `propriétaire : ${sP.raisons[g]}`, sM.raisons[g] && `membre : ${sM.raisons[g]}`].filter(Boolean);
      if (rs.length) raisons[g] = rs.join(' ; ');
    }
    if (apps.includes('prospection') && !communs.length) raisons.Prospection = raisons.Prospection ?? 'aucun espace commun au membre et au propriétaire';
    const portes = construirePortes(T, apps, sP.crm?.origine ?? '', communs, an0);
    const { mesurees, nonLues } = await controlePositif(portes, [sP, sM]);

    // Liens de connexion reçus avant, pas encore ouverts.
    const liens: { crm?: string; mail?: string; prospection?: string } = {};
    if (mesurees.some((x) => x.groupe === 'CRM') && sP.crm) liens.crm = await lienCrm(sP.crm.origine, M).catch(() => '');
    if (apps.includes('notifuse')) liens.mail = await lienRebond(sM.ctx, 'notifuse').catch(() => '');
    if (apps.includes('prospection')) liens.prospection = await lienRebond(sM.ctx, 'prospection').catch(() => '');

    // Academy : l'entrée avant le geste (sans quoi le refus après ne prouve rien).
    const rejoint = new Date();
    const syncAcademy = async (joined?: string): Promise<[number, string | undefined]> => {
      const x = await appelAcademy(`/api/tenants/${T.id}/sync-member`, { hub_user_id: M.hubUserId, email: M.email, role: 'member', email_proven: true, ...(joined ? { joined_at: joined } : {}) });
      return [x.status, ((await x.json().catch(() => null)) as { error?: string } | null)?.error];
    };
    let academyAvant = false;
    try {
      const a = await syncAcademy(rejoint.toISOString());
      academyAvant = a[0] === 200 && a[1] === undefined;
    } catch {
      academyAvant = false;
    }

    const ret = await admin<{ apps?: Issue[]; avis?: string | null }>('POST', `tenants/${T.id}/remove-member`, { hub_user_id: M.hubUserId });
    if (![200, 207].includes(ret.status)) throw new Error(`retrait : HTTP ${ret.status} ${masquer(JSON.stringify(ret.json)).slice(0, 200)}`);
    const dit = (ret.json.apps ?? []).map((a) => `${a.app}=${a.etat}`).join(' ');

    const dernier: Record<string, number> = {};
    const sondage = sonder(mesurees, sM, sP);
    // Les liens non consommés, ouverts juste après ; s'ils ouvrent une session, elle est sondée jusqu'au bout.
    const portesLiens = (async () => {
      const t0 = Date.now();
      const c1 = await r.browser.newContext();
      const c2 = await r.browser.newContext();
      ouverts.push(c1, c2);
      const neufs = liens.crm && sP.crm ? await consommer(sP.crm.origine, liens.crm).catch(() => ({ acces: null as string | null })) : null;
      const jm = liens.mail ? await jetonMail(c1, liens.mail) : null;
      if (liens.prospection) {
        const p = await c2.newPage();
        await p.goto(liens.prospection, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
        await p.close();
      }
      const lecteurs: Record<string, () => Promise<boolean>> = {};
      if (neufs?.acces && sP.crm) lecteurs.lien_crm = async () => Array.isArray(((await fetch(`${sP.crm!.origine}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${neufs.acces}` }, body: JSON.stringify({ query: COMPAGNIES }), signal: AbortSignal.timeout(15_000) }).then((x) => x.json()).catch(() => null)) as Json)?.data?.companies?.edges);
      if (jm) lecteurs.lien_mail = async () => (async (r: Response) => r.status === 200 && Array.isArray(((await r.json().catch(() => null)) as { contacts?: unknown } | null)?.contacts))(await fetch(`${APP_URL.notifuse}/api/contacts.list?workspace_id=${T.notifuseWorkspaceSlug}&limit=1`, { headers: { Authorization: `Bearer ${jm}` }, signal: AbortSignal.timeout(15_000) }));
      if (liens.prospection) lecteurs.lien_prospection = async () => (((await (await c2.request.get(`${APP_URL.prospection}/api/me`, { timeout: 15_000 })).json().catch(() => null)) as Json)?.workspaces ?? []).some((w: { id: string }) => communs.includes(w.id));
      while (Date.now() - t0 < DUREE) {
        for (const [x, f] of Object.entries(lecteurs)) if (await f().catch(() => false)) dernier[x] = Math.max(1, Date.now() - t0);
        await pause(1_500);
      }
      return Object.keys(lecteurs);
    })();
    const [res, lus] = await Promise.all([sondage, portesLiens]);
    Object.assign(dernier, res.dernier);
    // Un lien qui n'a rien ouvert n'est pas « fermé » en général : il n'est lu que s'il a été obtenu ; ses portes entrent dans le groupe de leur app.
    const liensPortes: Porte[] = lus.map((nom) => ({ groupe: nom === 'lien_crm' ? 'CRM' : nom === 'lien_mail' ? 'Mail' : 'Prospection', nom, tous: 0, lit: async () => false }));
    const v = bilan(
      apps.map((a) => GROUPES[a]).concat('Porte MCP'),
      [...portes, ...liensPortes],
      [...mesurees, ...liensPortes],
      nonLues,
      dernier,
      raisons,
    );

    // Academy : le Hub dit retiré, et un rejeu de synchronisation ne rend pas l'accès.
    const ac = (ret.json.apps ?? []).find((a) => a.app === 'academy');
    const supp: string[] = [];
    if (!ac || !academyAvant) supp.push(`Academy=non mesuré (${!ac ? 'le Hub ne la cite pas' : 'entrée préalable impossible'}) [attendu : réservée à Robert]`);
    else {
      const rejeu = [await syncAcademy().catch(() => [0, 'erreur'] as [number, string]), await syncAcademy(rejoint.toISOString()).catch(() => [0, 'erreur'] as [number, string])];
      const ferme = ac.etat === 'retire' && rejeu.every((x) => x[0] === 409 && x[1] === 'member_removed');
      supp.push(ferme ? 'Academy=fermé (retire, rejeu refusé 409)' : `Academy=encore ouvert (${ac.etat}, rejeu ${JSON.stringify(rejeu)})`);
    }
    if (res.perdus.length) throw new Error(`le témoin (propriétaire) a perdu : ${res.perdus.join(', ')} ; ${v.map((x) => x.texte).join(' ; ')}`);
    return `retrait Hub [${dit}] ; ` + conclure('retrait du membre', v, supp);
  } finally {
    await an0?.op.dispose();
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 5. Suspension de l'organisation
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * D'après 34, 38 et 21 : le propriétaire lit chaque porte avant ; l'organisation est suspendue (`suspension`) ; chaque porte est sondée 65 s (Mail, CRM, Prospection,
 * Analytics, porte MCP : la dernière lecture doit tomber sous 5 s) ; revenir par le Hub dans le CRM explique « Espace suspendu » (capture) ; la suspension est TOUJOURS
 * levée (finally) ; la reprise est dite « repris » app par app et le propriétaire relit chaque porte (même session, même jeton). Rend app par app fermé / encore ouvert /
 * non mesuré ; « encore ouvert » ou accès non rendu = FAUX. Academy : « non mesuré » dit (aucune porte lue chez elle, le Hub seul dit « suspendu »).
 * NON ABOUTI : propriétaire sans entrée dans une app, aucune porte lue, ou le Hub n'a pas pu lever (alors `fermerCoupures` réessaie).
 * Non porté : l'organisation d'à côté « qui ne bouge pas » (34 : une seconde organisation avec son propriétaire), les visites Analytics envoyées pendant et comptées après
 * (38 : création d'un site de test), la clé API du CRM, la réglage retenu pendant la suspension, et le refus d'un outil par programme (21) : cas 21, 34, 38.
 */
export async function suspensionOrganisation(r: Recette): Promise<string> {
  surProd();
  const T = await organisation(r);
  const apps = await appsDe(r);
  // Analytics : mesurée dès que la recette a une organisation Analytics, même si le document de l'organisation ne la cite pas (le Hub la
  // suspend quand même : 26/11, « analytics=suspendu » sans porte lue).
  const an0 = await analyticsDe(r);
  if (an0 && !apps.includes('analytics')) apps.push('analytics');
  const ouverts: BrowserContext[] = [];
  let levee = false;
  let repriseDite = '';
  let suspendues: string[] = [];
  let repris: Issue[] = [];
  try {
    const sP = await tenir(r, r.P, apps, ouverts, an0);
    await verifierEspaceRecette(r, T, sP, null);
    const raisons: Record<string, string> = {};
    for (const [g, x] of Object.entries(sP.raisons)) raisons[g] = x;
    const communs = sP.espaces;
    const portes = construirePortes(T, apps, sP.crm?.origine ?? '', communs, an0, true);
    const { mesurees, nonLues } = await controlePositif(portes, [sP]);
    if (!mesurees.length) throw new NonAbouti(`aucune porte lue avant la suspension : ${Object.entries(raisons).map(([g, x]) => `${g} ${x}`).join(' ; ')}`);

    const susp = await admin<{ apps?: Issue[] }>('POST', `tenants/${T.id}/suspension`, { suspendre: true, motif: 'TEST RECETTE' });
    if (![200, 207].includes(susp.status)) throw new Error(`suspension : HTTP ${susp.status} ${masquer(JSON.stringify(susp.json)).slice(0, 200)}`);
    let resultat: undefined | { v: Verdict[]; supp: string[]; dit: string; retour: string };
    try {
      const { dernier } = await sonder(mesurees, sP, null);
      const v = bilan(apps.map((a) => GROUPES[a]).concat('Academy', 'Porte MCP'), portes, mesurees, nonLues, dernier, raisons);
      // Academy est maintenant une porte mesurée (bandeau de lecture seule ou rebond refusé) : plus de ligne « non mesuré » d'office.
      const supp: string[] = [];

      // Revenir par le Hub dans le CRM : le Hub lit pourquoi et n'entre pas (l'anti-boucle du rebond dure 30 s).
      let retour = 'CRM absent de l\'organisation';
      if (apps.includes('twenty')) {
        const ctx = await r.browser.newContext({ storageState: r.P.etat as never });
        ouverts.push(ctx);
        let a = { chemin: '', texte: '' };
        for (let i = 0; i < 3 && a.chemin !== '/auth/bounce/error'; i++) {
          const page = await ctx.newPage();
          await page.goto(`${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL.twenty}/`)}`, { waitUntil: 'networkidle' }).catch(() => undefined);
          a = { chemin: new URL(page.url()).pathname, texte: await page.locator('body').innerText().catch(() => '') };
          if (a.chemin === '/auth/bounce/error' || i === 2) await r.capture(page, 'suspension-rebond-explique');
          await page.close();
          if (a.chemin !== '/auth/bounce/error') await pause(31_000);
        }
        retour = a.chemin === '/auth/bounce/error' && /Espace suspendu/.test(a.texte) ? 'rebond CRM : « Espace suspendu » dit' : `rebond CRM : ${a.chemin} ${masquer(a.texte).slice(0, 80)}`;
        if (!/Espace suspendu/.test(a.texte)) supp.push(`rebond CRM encore ouvert ou muet (${retour})`);
      }
      resultat = { v, supp, dit: (susp.json.apps ?? []).map((x) => `${x.app}=${x.etat}`).join(' '), retour };
    } finally {
      suspendues = (susp.json.apps ?? []).filter((x) => x.etat === 'suspendu').map((x) => x.app);
      // Épreuve `SSO_SABOTAGE=reprise-oubliee` : le Hub ne reprend rien, mais la recette le croit sur parole (« repris » partout). Seule la
      // relecture DANS chaque app peut faire tomber l'étape : c'est elle qui aurait vu Prospection restée fermée le 26/11 à 14:22.
      if (process.env.SSO_SABOTAGE === 'reprise-oubliee') {
        levee = true;
        repriseDite = suspendues.map((a) => `${a}=repris (épreuve : non appelé)`).join(' ');
        repris = suspendues.map((app) => ({ app, etat: 'repris' }) as Issue);
      } else {
        const rep = await admin<{ apps?: Issue[] }>('POST', `tenants/${T.id}/suspension`, { suspendre: false });
        levee = [200, 207].includes(rep.status);
        repriseDite = (rep.json?.apps ?? []).map((x) => `${x.app}=${x.etat}`).join(' ');
        repris = rep.json?.apps ?? [];
      }
    }
    if (!levee) throw new NonAbouti('la suspension n\'a pas pu être levée par le Hub (HTTP refusé) : `fermerCoupures` réessaie');
    // Tout ce qui a été suspendu est repris, dit par le Hub.
    const nonRepris = suspendues.filter((a) => repris.find((x) => x.app === a)?.etat !== 'repris');
    // Le propriétaire relit chaque porte, même session et même jeton.
    const t0 = Date.now();
    let manque: string[] = mesurees.map((x) => x.nom);
    while (Date.now() - t0 < 90_000 && manque.length) {
      manque = [];
      for (const x of mesurees) if (!(await x.lit(sP).catch(() => false))) manque.push(x.nom);
      if (manque.length) await pause(3_000);
    }
    if (!resultat) throw new NonAbouti('suspension : aucune mesure');
    const apres = resultat;
    const detail = conclure('suspension', apres.v, apres.supp);
    if (nonRepris.length) throw new Error(`reprise : ${nonRepris.join(', ')} non repris par le Hub [${repriseDite}]`);
    if (manque.length) throw new Error(`reprise : le propriétaire ne relit pas ${manque.join(', ')} 90 s après la levée [${repriseDite}]`);
    return `suspension Hub [${apres.dit}] ; ${detail} ; ${apres.retour} ; reprise [${repriseDite}] : ${mesurees.length} portes relues par le propriétaire`;
  } finally {
    if (!levee || process.env.SSO_SABOTAGE === 'reprise-oubliee') await admin('POST', `tenants/${T.id}/suspension`, { suspendre: false }).catch(() => undefined);
    await an0?.op.dispose();
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}
/** Rendu pour l'assemblage : les apps que ce fichier sait mesurer, et les étapes dans l'ordre de la recette. */
export const ETAPES_COUPURES: [string, (r: Recette) => Promise<string>][] = [
  ['Inviter un membre', inviterMembre],
  ['SSO d\'organisation en libre service', ssoLibre],
  ['Connexion obligatoire, puis remise en libre', ssoObligatoire],
  ['Retrait du membre', retraitMembre],
  ['Suspension de l\'organisation, puis reprise', suspensionOrganisation],
];

export type { Page };
