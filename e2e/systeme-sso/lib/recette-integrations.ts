/**
 * Recette de A à Z (cas 50), étapes d'intégration : Mon IA, la délégation CRM vers Mail, la réponse humaine de Mail vers le CRM (VER-247) et
 * « Envoyer au CRM » de Prospection (VER-246). Chaque étape rend un détail court si VRAI, lève `NonAbouti` si on n'a pas pu mesurer, et une
 * `Error` si l'assertion est fausse. Règles tenues ici, pour la prod : aucun mail réel (les actions jouées sont des LECTURES), aucune séquence
 * allumée ni inscrite (la liaison `#sequences` est mesurée éteinte, jamais touchée), aucune adresse ni secret dans un message rendu.
 * Extraites des cas 15, 23, 25, 27 et 49, adaptées à l'organisation jetable déjà créée par la recette.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { BrowserContext, Page } from '@playwright/test';

import { APP_URL, HUB_URL, masquer } from './cibles';
import { NonAbouti } from './etat';
import { admin, adminOk, lookup, secretDe, secretServiStaging } from './hub-admin';
import { obtenirJetonMcp, outil } from './mcp';
import { ouvrirApp } from './parcours';
import type { Recette } from './recette';
import { signatureVersApp } from './signature-app';

const STAGING = /staging/.test(HUB_URL);
const MODELE_GRATUIT = 'nvidia/nemotron-3-ultra-550b-a55b:free'; // appel d'outil vérifié à 0 $ le 22/11 (cas 15)
const PAIRE_CRM_MAIL = 'crm>notifuse';
const PAIRE_CRM_ACADEMY = 'crm>academy';
const PAIRE_SEQUENCES = 'crm>notifuse#sequences';
const PAIRE_MAIL_CRM = 'notifuse>crm';
const PAIRE_PROSPECTION_CRM = 'prospection>crm';

type Liaison = { paire: string; etat: 'allumee' | 'eteinte' | 'indisponible'; nature: string; consentie: boolean; par_defaut: boolean; reglee_par_quelqu_un: boolean; dernier_passage: string | null; derniere_erreur: string | null };

/** Texte libre prudent : masqué (jetons, JWT) et borné. Jamais une adresse : on ne passe ici que des codes et des statuts. */
const m = (s: unknown, n = 160): string => masquer(typeof s === 'string' ? s : JSON.stringify(s) ?? '').slice(0, n);

/** L'état des liaisons de l'organisation, tel que le Hub le tient (lecture seule, aucune poignée, aucune ligne écrite). */
async function liaisons(r: Recette): Promise<Liaison[]> {
  const res = await admin<{ liaisons?: Liaison[]; error?: string }>('GET', `tenants/${r.tenantId}/liaisons`);
  if (res.status === 404 && res.json?.error === 'tenant_introuvable') throw new NonAbouti('organisation jetable introuvable au Hub');
  if (res.status !== 200 || !Array.isArray(res.json?.liaisons)) throw new NonAbouti(`lecture des liaisons : HTTP ${res.status} ${m(res.json?.error ?? '')}`);
  return res.json.liaisons;
}

/** Page du Hub du propriétaire : un contexte connecté, la page demandée, NON ABOUTI si la session ne tient pas. */
async function ouvrirPageHub(r: Recette, chemin: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await r.contexte(r.P);
  try {
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}${chemin}`, { waitUntil: 'networkidle' });
    if (/\/login|\/auth\//.test(new URL(page.url()).pathname)) throw new NonAbouti(`${chemin} : renvoyé vers la connexion, session Hub du propriétaire non valable`);
    return { ctx, page };
  } catch (e) {
    await ctx.close().catch(() => undefined);
    throw e;
  }
}

/** Le formulaire de réglage d'une paire dans CETTE organisation (la page liste tous les espaces du compte). */
const reglage = (page: Page, r: Recette, paire: string) =>
  page.locator('form', { has: page.locator(`input[name="tenant"][value="${r.tenantId}"]`) }).filter({ has: page.locator(`input[name="paire"][value="${paire}"]`) });

/** Secret de la source CRM pour demander un jeton de délégation (même nom que la découverte signée de `hub-admin`). */
function secretCrm(): string {
  return STAGING ? secretServiStaging('CRM_HUB_API_SECRET') : secretDe('CRM_HUB_API_SECRET_PROD');
}

/** Échange la poignée d'une personne contre un jeton d'action de 120 s, signé comme le ferait l'app source. */
async function echanger(source: 'crm', secret: string, grant: string, audience: string, scope: string): Promise<{ status: number; json: any }> {
  const corps = JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_grant: grant, audience, scope });
  const ts = String(Date.now());
  const nonce = randomBytes(18).toString('base64url');
  let rep: Response;
  try {
    rep = await fetch(`${HUB_URL}/api/delegation/jeton`, {
      method: 'POST',
      // vers-le-hub : jeton de délégation signé par une app, vérifié par le Hub (lib/delegation/jeton.ts).
      headers: { 'content-type': 'application/json', 'x-veridian-app': source, 'x-veridian-timestamp': ts, 'x-veridian-nonce': nonce, 'x-veridian-hub-signature': createHmac('sha256', secret).update(`${ts}.${nonce}.${corps}`).digest('hex') },
      body: corps,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new NonAbouti(`échange de jeton : Hub injoignable (${m((e as Error).message, 80)})`);
  }
  return { status: rep.status, json: await rep.json().catch(() => null) };
}

// ───────────────────────────────────────────────────────── 1. Mon IA (VER-203)

/**
 * Mon IA : le propriétaire branche une clé (modèle gratuit, 0 $), allume l'assistant, pose une question ; l'IA lit une donnée réelle par la porte MCP
 * (hub.mon_compte) et la clé n'apparaît ni dans la réponse du branchement ni dans le flux. Le branchement est retiré à la fin.
 */
export async function monIA(r: Recette): Promise<string> {
  const cle = secretDe('OPENROUTER_API_KEY');
  const ctx = await r.contexte(r.P);
  try {
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/dashboard/ia`, { waitUntil: 'networkidle' });
    if (/\/login/.test(new URL(page.url()).pathname)) throw new NonAbouti('/dashboard/ia : renvoyé vers la connexion, session Hub du propriétaire non valable');
    const texte = (await page.locator('main').innerText().catch(() => '')).trim();
    if (texte.length < 40) throw new Error(`/dashboard/ia : écran vide (${texte.length} caractères)`);
    await r.capture(page, 'ia-avant-branchement');

    const api = ctx.request;
    const b = await api.post(`${HUB_URL}/api/ia/branchement`, { data: { fournisseur: 'openrouter', modele: MODELE_GRATUIT, cle } });
    try {
      if (b.status() !== 200) throw new Error(`branchement refusé : HTTP ${b.status()} ${m(await b.text(), 100)}`);
      if ((await b.text()).includes(cle)) throw new Error('la clé revient en clair dans la réponse du branchement');

      const a = await api.post(`${HUB_URL}/api/ia/activation`, { data: { app: 'academy', tenantId: r.tenantId, enabled: true } });
      if (a.status() !== 200) throw new Error(`activation refusée : HTTP ${a.status()} ${m(await a.text(), 100)}`);

      await page.reload({ waitUntil: 'networkidle' });
      await r.capture(page, 'ia-branche');

      const question = {
        app: 'academy',
        tenantId: r.tenantId,
        messages: [{ id: 'q1', role: 'user', parts: [{ type: 'text', text: 'Quels sont mes plans Veridian ? Utilise hub.mon_compte par les outils, puis réponds en une phrase.' }] }],
      };
      const c = await api.post(`${HUB_URL}/api/ia/chat`, { data: question, timeout: 120_000 });
      const flux = await c.text();
      if (flux.includes(cle)) throw new Error('la clé apparaît dans le flux du chat');
      if (c.status() === 429) throw new NonAbouti('plafond du fournisseur gratuit atteint : chat non joué');
      if (c.status() === 503) throw new NonAbouti(`chat indisponible (coffre ou fournisseur) : ${m(flux, 100)}`);
      if (c.status() !== 200) throw new Error(`chat : HTTP ${c.status()} ${m(flux, 160)}`);
      if (!/executer_outil|hub\.mon_compte/.test(flux)) throw new Error(`aucun appel d'outil de la porte dans le flux : ${m(flux, 200)}`);
      if (!/"sessionId"/.test(flux)) throw new Error("le Hub n'a pas rendu d'identifiant de session");
      // La donnée réelle : le plan Mail de l'organisation, tel que le Hub le tient.
      const plan = (await lookup(r.P.email)).json?.tenants?.find((t: { id: string }) => t.id === r.tenantId)?.notifusePlan ?? (await lookup(r.P.email)).json?.tenants?.[0]?.notifusePlan;
      if (plan && !new RegExp(String(plan), 'i').test(flux)) throw new Error(`la réponse ne reprend pas le plan réel (${plan})`);
      return `/dashboard/ia vu avant et après branchement, outil de la porte appelé, plan réel « ${plan ?? '?'} » dans la réponse, clé absente du flux`;
    } finally {
      await api.post(`${HUB_URL}/api/ia/activation`, { data: { app: 'academy', tenantId: r.tenantId, enabled: false } }).catch(() => undefined);
      await api.delete(`${HUB_URL}/api/ia/branchement?fournisseur=openrouter`).catch(() => undefined);
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

// ───────────────────────────────────────────────────────── 2. Délégation CRM vers Mail

/**
 * La liaison `crm>notifuse` : active par défaut, la liaison `#sequences` éteinte (elle fait partir du courrier), les deux vues à l'écran du propriétaire,
 * puis un VRAI jeton de délégation du CRM reconnu par Mail sur une LECTURE (`listes.lister`), usé après un passage. Jamais d'envoi, jamais d'inscription.
 */
export async function delegationCrmVersMail(r: Recette): Promise<string> {
  const l = await liaisons(r);
  const a = l.find((x) => x.paire === PAIRE_CRM_MAIL);
  const s = l.find((x) => x.paire === PAIRE_SEQUENCES);
  if (!a || !s) throw new Error(`le Hub ne connaît pas ${!a ? PAIRE_CRM_MAIL : PAIRE_SEQUENCES} (registre des paires)`);
  if (a.etat !== 'allumee' || !a.par_defaut) throw new Error(`${PAIRE_CRM_MAIL} : attendue allumée par défaut, vue ${a.etat}${a.par_defaut ? '' : ' (non par défaut)'}`);
  if (s.etat !== 'eteinte') throw new Error(`${PAIRE_SEQUENCES} : attendue éteinte (elle envoie des mails), vue ${s.etat}`);

  const { ctx, page } = await ouvrirPageHub(r, '/dashboard/liaisons');
  try {
    const corps = await page.locator('main').innerText().catch(() => '');
    if (!/CRM vers Mail/.test(corps)) throw new Error(`/dashboard/liaisons ne montre pas « CRM vers Mail » : ${m(corps, 160)}`);
    // Rien n'est cliqué : « Couper » sur la liaison active, « Allumer » sur celle des séquences.
    const bA = await reglage(page, r, PAIRE_CRM_MAIL).getByRole('button').allInnerTexts();
    const bS = await reglage(page, r, PAIRE_SEQUENCES).getByRole('button').allInnerTexts();
    if (!bA.includes('Couper')) throw new Error(`écran : ${PAIRE_CRM_MAIL} devrait proposer « Couper » (active), vu [${bA.join(', ')}]`);
    if (!bS.includes('Allumer')) throw new Error(`écran : ${PAIRE_SEQUENCES} devrait proposer « Allumer » (éteinte), vu [${bS.join(', ')}]`);
    if (!/Active par défaut/.test(corps)) throw new Error('écran : la mention « Active par défaut » manque');
    await r.capture(page, 'liaisons-crm-mail');
  } finally {
    await ctx.close().catch(() => undefined);
  }

  // Le jeton : la poignée du propriétaire pour la source CRM, échangée comme le CRM le ferait.
  const secret = secretCrm();
  const p = await admin<{ delegations?: { hub_tenant_id: string; grant: string }[]; error?: string }>('POST', 'delegation/poignee', { email: r.P.email, app: 'crm' });
  if (p.status !== 200) throw new NonAbouti(`poignée du propriétaire : HTTP ${p.status} ${m(p.json?.error ?? '')}`);
  const grant = p.json.delegations?.find((d) => d.hub_tenant_id === r.tenantId)?.grant;
  if (!grant) throw new NonAbouti("aucune poignée émise pour l'organisation jetable (source CRM non servie pour elle ?)");

  // D'abord la preuve que l'interrupteur des séquences tient : aucun jeton de séquences, et on n'en réutilise jamais un.
  const seq = await echanger('crm', secret, grant, 'notifuse', 'notifuse:sequences.inscrire');
  if (seq.status === 200) throw new Error('un jeton « sequences.inscrire » a été délivré alors que la liaison est éteinte (non utilisé)');
  if (seq.status === 401 || seq.status === 503) throw new NonAbouti(`échange refusé avant la mesure : HTTP ${seq.status} ${m(seq.json?.error ?? '')}`);
  if (seq.json?.error !== 'integration_off') throw new Error(`séquences : refus attendu « integration_off », vu HTTP ${seq.status} ${m(seq.json?.error ?? '')}`);

  const e = await echanger('crm', secret, grant, 'notifuse', 'notifuse:contacts.ecrire');
  if (e.status === 401 || e.status === 503) throw new NonAbouti(`échange refusé avant la mesure : HTTP ${e.status} ${m(e.json?.error ?? '')}`);
  if (e.status !== 200 || !e.json?.access_token) throw new Error(`échange du jeton CRM vers Mail : HTTP ${e.status} ${m(e.json?.error ?? '')}`);
  if (e.json.tenant_id !== r.tenantId) throw new Error("le jeton porte une autre organisation que l'organisation jetable");
  const jeton = e.json.access_token as string;
  const url = String(e.json.url ?? '');
  if (!/^https:\/\/[a-z0-9.-]+\.veridian\.site\/api\/veridian\/actions$/.test(url)) throw new Error(`adresse d'action hors du domaine Veridian (${m(url, 80)}) : jeton non envoyé`);

  const lire = async () => {
    try {
      const rep = await fetch(`${url}/listes.lister`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` }, body: '{}', signal: AbortSignal.timeout(60_000) });
      return { status: rep.status, json: (await rep.json().catch(() => null)) as any };
    } catch (err) {
      throw new NonAbouti(`Mail injoignable : ${m((err as Error).message, 80)}`);
    }
  };
  const un = await lire();
  if (un.status === 404 && !un.json) throw new NonAbouti("la route d'actions de Mail est absente de ce qui est servi (404 sans réponse JSON)");
  if (un.status >= 500) throw new NonAbouti(`Mail en erreur : HTTP ${un.status} ${m(un.json?.code ?? un.json?.error ?? '')}`);
  if (un.status !== 200) throw new Error(`Mail refuse la lecture déléguée : HTTP ${un.status} ${m(un.json?.code ?? un.json?.error ?? '')}`);
  const deux = await lire();
  if (deux.status !== 401) throw new Error(`jeton déjà vu : attendu 401, vu HTTP ${deux.status}`);
  return `liaison ${PAIRE_CRM_MAIL} active par défaut, ${PAIRE_SEQUENCES} éteinte (jeton refusé integration_off), écran vérifié, jeton du CRM reconnu par Mail sur une lecture (listes), rejoué refusé 401, aucun envoi`;
}

/** Le propriétaire règle la paire par SON écran : « Allumer » (avec la page de confirmation) ou « Couper ». Capture après le geste. */
async function geste(r: Recette, paire: string, quoi: 'Allumer' | 'Couper', capture: string): Promise<void> {
  const { ctx, page } = await ouvrirPageHub(r, '/dashboard/liaisons');
  try {
    const f = reglage(page, r, paire);
    if ((await f.count()) !== 1) throw new Error(`${paire} non proposée à l'écran du propriétaire : ${m(await page.locator('main').innerText().catch(() => ''), 160)}`);
    await f.getByRole('button', { name: quoi }).click();
    if (quoi === 'Allumer') {
      await page.waitForURL(/\/liaisons\/confirmer\//, { timeout: 30_000 });
      await page.getByRole('button', { name: 'Allumer' }).click();
      await page.getByText('Liaison allumée').waitFor({ timeout: 30_000 });
    } else {
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
    }
    await r.capture(page, capture);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

// ───────────────────────────────────────────────────────── 2 bis. Délégation CRM vers Academy (VER-208)

/**
 * La liaison `crm>academy` (lecture de l'avancement, seule action d'Academy : `avancement.lire`, route `/api/veridian/actions/:action`, source
 * veridian-academy/src/lib/actions.ts). Éteinte au départ : le PROPRIÉTAIRE l'allume par son écran, un VRAI jeton du CRM est reconnu par Academy sur
 * une lecture de l'avancement de sa propre adresse (rien n'est écrit), rejoué il est refusé, une portée hors de la paire est refusée par le Hub.
 * Le propriétaire coupe ensuite par son écran (retour à l'état initial). NON ABOUTI si Academy est réservée (acces_reserve), non reliée ou absente.
 */
export async function delegationCrmVersAcademy(r: Recette): Promise<string> {
  const lire = async () => {
    const p = (await liaisons(r)).find((x) => x.paire === PAIRE_CRM_ACADEMY);
    if (!p) throw new Error(`le Hub ne connaît pas ${PAIRE_CRM_ACADEMY} (registre des paires)`);
    return p;
  };
  const initiale = await lire();
  if (initiale.etat === 'indisponible') {
    throw new NonAbouti(`${PAIRE_CRM_ACADEMY} indisponible au Hub (DELEGATION_CIBLES doit nommer academy@test et DELEGATION_SOURCES le CRM ; organisation non marquée de test ?)`);
  }
  const vus: string[] = [`état initial ${initiale.etat}`];
  let allumeParNous = false;
  let verdict: string | null = null;
  let echec: unknown = null;
  try {
    if (initiale.etat === 'eteinte') {
      await geste(r, PAIRE_CRM_ACADEMY, 'Allumer', 'liaison-crm-academy-allumee');
      allumeParNous = true;
      const apres = await lire();
      if (apres.etat !== 'allumee') throw new Error(`après « Allumer » par l'écran du propriétaire, ${PAIRE_CRM_ACADEMY} reste ${apres.etat}`);
      vus.push('allumée par le propriétaire');
    }

    const secret = secretCrm();
    const p = await admin<{ delegations?: { hub_tenant_id: string; grant: string }[]; error?: string }>('POST', 'delegation/poignee', { email: r.P.email, app: 'crm' });
    if (p.status !== 200) throw new NonAbouti(`poignée du propriétaire : HTTP ${p.status} ${m(p.json?.error ?? '')}`);
    const grant = p.json.delegations?.find((d) => d.hub_tenant_id === r.tenantId)?.grant;
    if (!grant) throw new NonAbouti("aucune poignée émise pour l'organisation jetable (source CRM non servie pour elle ?)");

    // Une portée hors de la paire : refusée par le Hub avant tout jeton, rien n'est écrit nulle part.
    const hors = await echanger('crm', secret, grant, 'academy', 'academy:avancement.ecrire');
    if (hors.status === 401 || hors.status === 503) throw new NonAbouti(`échange refusé avant la mesure : HTTP ${hors.status} ${m(hors.json?.error ?? '')}`);
    if (hors.status === 200) throw new Error('un jeton a été délivré pour une portée hors de la paire (academy:avancement.ecrire), non utilisé');
    if (hors.json?.error !== 'pair_not_allowed') throw new Error(`portée hors paire : refus attendu « pair_not_allowed », vu HTTP ${hors.status} ${m(hors.json?.error ?? '')}`);
    vus.push('portée hors paire refusée 403');

    const e = await echanger('crm', secret, grant, 'academy', 'academy:avancement.lire');
    if (e.status === 401 || e.status === 503) throw new NonAbouti(`échange refusé avant la mesure : HTTP ${e.status} ${m(e.json?.error ?? '')}`);
    if (e.status === 403 && ['app_not_open', 'target_not_served'].includes(e.json?.error)) throw new NonAbouti(`Academy non servie à cette organisation : ${m(e.json.error)}`);
    if (e.status !== 200 || !e.json?.access_token) throw new Error(`échange du jeton CRM vers Academy : HTTP ${e.status} ${m(e.json?.error ?? '')}`);
    if (e.json.tenant_id !== r.tenantId) throw new Error("le jeton porte une autre organisation que l'organisation jetable");
    const jeton = e.json.access_token as string;
    const url = String(e.json.url ?? '');
    if (!/^https:\/\/[a-z0-9.-]+\.veridian\.site\/api\/veridian\/actions$/.test(url)) throw new Error(`adresse d'action hors du domaine Veridian (${m(url, 80)}) : jeton non envoyé`);

    const jouer = async () => {
      try {
        const rep = await fetch(`${url}/avancement.lire`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` }, body: JSON.stringify({ emails: [r.P.email] }), signal: AbortSignal.timeout(60_000) });
        return { status: rep.status, json: (await rep.json().catch(() => null)) as any };
      } catch (err) {
        throw new NonAbouti(`Academy injoignable : ${m((err as Error).message, 80)}`);
      }
    };
    const un = await jouer();
    if (un.status === 404 && !un.json) throw new NonAbouti("la route d'actions d'Academy est absente de ce qui est servi (404 sans réponse JSON)");
    if (un.status >= 500) throw new NonAbouti(`Academy en erreur : HTTP ${un.status} ${m(un.json?.error ?? '')}`);
    const code = String(un.json?.error ?? '');
    if (un.status === 403 && code === 'acces_reserve') throw new NonAbouti("Academy est réservée (ACCES_RESERVE) : le jeton est reconnu mais le compte de test n'y est pas admis, lecture non jouée");
    if (un.status === 409 && code === 'espace_non_relie') throw new NonAbouti("Academy ne connaît pas l'espace de l'organisation jetable (espace_non_relie)");
    if (un.status === 403 && ['non_membre', 'utilisateur_inconnu'].includes(code)) throw new NonAbouti(`Academy ne connaît pas le propriétaire comme membre (${code}) : entrée SSO non faite ?`);
    if (un.status !== 200) throw new Error(`Academy refuse la lecture déléguée : HTTP ${un.status} ${m(code)}`);
    if (un.json?.action !== 'avancement.lire' || !Array.isArray(un.json?.resultat?.inscriptions)) throw new Error(`réponse d'Academy inattendue : ${m(un.json, 120)}`);
    vus.push(`lecture reconnue par Academy 200 (${un.json.resultat.inscriptions.length} inscription)`);
    const deux = await jouer();
    if (deux.status !== 401) throw new Error(`jeton déjà vu : attendu 401, vu HTTP ${deux.status}`);
    vus.push('rejoué refusé 401');
    verdict = `${PAIRE_CRM_ACADEMY} : ${vus.join(', ')}`;
  } catch (e) {
    echec = e;
  }

  // Retour à l'état initial, par l'écran du propriétaire, même après un défaut.
  if (allumeParNous) {
    try {
      await geste(r, PAIRE_CRM_ACADEMY, 'Couper', 'liaison-crm-academy-coupee');
      const fin = await lire();
      if (fin.etat !== 'eteinte') throw new Error(`après « Couper », ${PAIRE_CRM_ACADEMY} reste ${fin.etat} (laissée allumée)`);
      vus.push('coupée par le propriétaire, relue éteinte');
      if (verdict) verdict += ', coupée par le propriétaire, relue éteinte';
    } catch (c) {
      if (!echec) echec = c;
      else console.error(`[recette] coupure de ${PAIRE_CRM_ACADEMY} : ${m((c as Error).message, 160)}`);
    }
  }
  if (echec) throw echec;
  return verdict ?? vus.join(', ');
}

// ───────────────────────────────────────────────────────── 3. Réponse de Mail vers le CRM (VER-247)

/**
 * VER-247 : une réponse humaine reçue dans Mail devient UNE tâche au CRM (une fois, rejoué sans effet). Exige que la liaison `notifuse>crm` soit
 * ouverte pour l'organisation (`DELEGATION_EVENEMENTS`) : sinon NON ABOUTI, avant tout geste. Aucune boîte de lecture n'existe (lib/boite.ts) : la
 * livraison est donc jouée signée, avec le secret que Mail rend au Hub, et l'ÉMISSION de Mail n'est pas mesurée. Aucun mail ne part.
 */
export async function reponseMailVersCrm(r: Recette): Promise<string> {
  const l = await liaisons(r);
  const p = l.find((x) => x.paire === PAIRE_MAIL_CRM);
  if (!p || p.etat === 'indisponible') {
    throw new NonAbouti(`${PAIRE_MAIL_CRM} n'est pas ouverte pour cette organisation (indisponible : DELEGATION_EVENEMENTS ne nomme que des organisations précises en prod). Aucune boîte de lecture non plus (lib/boite.ts : Lark abandonné, boîte de Robert interdite). Rien n'a été envoyé ni écrit.`);
  }
  if (STAGING) throw new NonAbouti('étape jouée en prod ; le cas 27 couvre staging');
  const mailHub = secretDe('NOTIFUSE_HUB_API_SECRET');
  const MAIL = APP_URL.notifuse;
  const T = (await lookup(r.P.email)).json?.tenants?.find((t: { id: string }) => t.id === r.tenantId);
  if (!T?.slug) throw new NonAbouti("slug de l'espace au Hub illisible");

  // Le propriétaire allume, si ce n'est pas déjà fait : un événement n'est jamais actif par défaut (clic et confirmation).
  if (p.etat !== 'allumee') {
    const { ctx, page } = await ouvrirPageHub(r, '/dashboard/liaisons');
    try {
      const f = reglage(page, r, PAIRE_MAIL_CRM);
      if ((await f.count()) !== 1) throw new Error(`liaison non proposée à l'écran : ${m(await page.locator('main').innerText().catch(() => ''), 200)}`);
      await f.getByRole('button', { name: 'Allumer' }).click();
      await page.waitForURL(/\/liaisons\/confirmer\//, { timeout: 30_000 });
      await page.getByRole('button', { name: 'Allumer' }).click();
      await page.getByText('Liaison allumée').waitFor({ timeout: 30_000 });
      await r.capture(page, 'liaison-mail-crm-allumee');
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }

  const versMail = async (chemin: string, corps: object) => {
    const body = JSON.stringify(corps);
    const rep = await fetch(`${MAIL}${chemin}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signatureVersApp('notifuse', mailHub, 'POST', `${MAIL}${chemin}`, body) }, body, signal: AbortSignal.timeout(60_000) }).catch((err) => {
      throw new NonAbouti(`Mail injoignable : ${m((err as Error).message, 80)}`);
    });
    return { status: rep.status, json: (await rep.json().catch(() => null)) as any };
  };
  const abo = await versMail('/api/hub/evenements/abonnement', { hub_tenant_id: r.tenantId, actif: true });
  if (abo.status !== 200 || !abo.json?.secret) throw new NonAbouti(`abonnement de Mail au Hub : HTTP ${abo.status}`);
  if (abo.json.url !== `${HUB_URL}/api/evenements/notifuse`) throw new Error('Mail livre à une autre adresse que ce Hub');
  const cle = Buffer.from(String(abo.json.secret).replace('whsec_', ''), 'base64');
  const n = Date.now().toString(36);
  const recevoir = async (id: string, data: object = {}) => {
    const corps = JSON.stringify({ id, type: 'message.received', workspace_id: abo.json.workspace_id, timestamp: new Date().toISOString(), data: { message_id: `m-${id}`, rfc_message_id: `${id}@e2e.invalid`, kind: 'reply_human', match_type: 'message_id', direction: 'in', email: `contact@recette${n}.invalid`, thread_id: `t_${n}`, event_timestamp: new Date().toISOString(), ...data } });
    const ts = String(Math.floor(Date.now() / 1000));
    // vers-le-hub : webhook signé par Mail, vérifié par le Hub.
    const rep = await fetch(`${HUB_URL}/api/evenements/notifuse`, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${createHmac('sha256', cle).update(`${id}.${ts}.${corps}`).digest('base64')}` }, body: corps, signal: AbortSignal.timeout(60_000) });
    // Le Hub rend toujours du JSON : un corps qui n'en est pas vient d'un intermédiaire (Cloudflare, Traefik). On le garde, avec qui l'a servi
    // (26/11 : cinq « 502 null » sans trace au Hub ni dans Loki).
    const texte = await rep.text().catch(() => '');
    let json: any = null;
    try { json = JSON.parse(texte); } catch { json = { brut: m(texte.replace(/\s+/g, ' '), 160), serveur: rep.headers.get('server'), cf_ray: rep.headers.get('cf-ray') }; }
    return [rep.status, json] as const;
  };
  /** Comme Mail : un 5xx se réessaie avec le même identifiant. */
  const livrer = async (id: string) => {
    let rep = await recevoir(id);
    for (let i = 0; i < 4 && rep[0] >= 500; i++) {
      await new Promise((ok) => setTimeout(ok, 10_000));
      rep = await recevoir(id);
    }
    return rep;
  };

  const jeton = await obtenirJetonMcp(r.browser, r.P, 'RECETTE VER-247');
  const compter = async () => {
    const t = (await outil(jeton, 'executer_outil', { nom: 'twenty.find_many_tasks', arguments: { limit: 100, select: ['id', 'title'] }, espace: T.slug })).texte.replace(/\\"/g, '"');
    if (!/"success":\s*true|"records"|"count"|"result"/.test(t)) throw new NonAbouti(`lecture des tâches du CRM : ${m(t, 120)}`);
    return new Set(t.match(/"id":\s*"[0-9a-f-]{36}"/g) ?? []).size;
  };
  const avant = await compter();
  const id = randomUUID();
  const premiere = await livrer(id);
  if (premiere[0] !== 200 || !premiere[1]?.ok) throw new Error(`livraison de la réponse : HTTP ${premiere[0]} ${m(premiere[1])}`);
  if (!['cree', 'rejoue', 'aucun'].includes(premiere[1].effet)) throw new Error(`effet inattendu : ${m(premiere[1].effet)}`);
  const apres = await compter();
  if (apres - avant !== 1) throw new Error(`une tâche de plus attendue au CRM, vu ${apres - avant}`);
  const meme = await livrer(id);
  if (meme[0] !== 200 || meme[1]?.raison !== 'deja_traite') throw new Error(`même livraison rejouée : attendu deja_traite, vu HTTP ${meme[0]} ${m(meme[1])}`);
  if ((await compter()) !== apres) throw new Error('le rejeu a créé une seconde tâche');
  return 'réponse humaine (livraison signée, sans boîte de lecture ni mail réel) : une tâche au CRM, rejeu sans effet ; émission réelle de Mail non mesurée';
}

// ───────────────────────────────────────────────────────── 4. « Envoyer au CRM » de Prospection (VER-246)

/**
 * VER-246 : la paire `prospection>crm` est-elle SERVIE, des deux côtés ? Hub (paire, état, écran du propriétaire) et Prospection (`GET /api/liaisons/etat`,
 * en lecture, d'où vient le drapeau `ATLAS_LIAISONS`). NON ABOUTI avec la raison exacte si le bouton n'est pas servi. Le geste d'envoi n'est pas
 * joué : il écrit une fiche au CRM et exige un plan payant.
 */
export async function envoyerAuCrm(r: Recette): Promise<string> {
  const l = await liaisons(r);
  const p = l.find((x) => x.paire === PAIRE_PROSPECTION_CRM);
  if (!p) throw new Error(`le Hub ne connaît pas ${PAIRE_PROSPECTION_CRM}`);

  const { ctx: ctxHub, page } = await ouvrirPageHub(r, '/dashboard/liaisons');
  let visibleAuHub: boolean;
  try {
    visibleAuHub = (await reglage(page, r, PAIRE_PROSPECTION_CRM).count()) === 1;
    await r.capture(page, 'liaisons-prospection-crm');
  } finally {
    await ctxHub.close().catch(() => undefined);
  }
  if (p.etat === 'indisponible') {
    throw new NonAbouti(`${PAIRE_PROSPECTION_CRM} indisponible au Hub (la liaison n'est pas servie : source Prospection ou cible CRM fermée, DELEGATION_SOURCES et DELEGATION_CIBLES de deploy/hub.nomad.hcl)${visibleAuHub ? '' : ', absente de l\'écran'}.`);
  }
  if (p.etat === 'eteinte') {
    throw new NonAbouti(`${PAIRE_PROSPECTION_CRM} éteinte au Hub dans cette organisation (Prospection ou CRM non ouvert pour elle, ou coupée) : bouton non proposé.`);
  }
  if (!visibleAuHub) throw new Error(`${PAIRE_PROSPECTION_CRM} allumée au Hub mais absente de /dashboard/liaisons`);

  // Côté Prospection : le vrai chemin du propriétaire (rebond depuis le Hub), puis l'état que l'écran lit pour afficher « Envoyer au CRM ».
  const ctx = await r.contexte(r.P);
  try {
    const a = await ouvrirApp(ctx, 'prospection');
    if (a.hote !== new URL(APP_URL.prospection).host) throw new NonAbouti(`ouverture de Prospection par le rebond : atterri sur ${a.hote}${a.chemin} au lieu de Prospection`);
    const rep = await ctx.request.get(`${APP_URL.prospection}/api/liaisons/etat`, { timeout: 30_000 });
    if (rep.status() === 401) throw new NonAbouti('Prospection : pas de session après le rebond, état des liaisons illisible');
    if (rep.status() === 404) throw new NonAbouti("Prospection servie sans la route /api/liaisons/etat (VER-246 non déployé)");
    if (rep.status() !== 200) throw new NonAbouti(`Prospection : /api/liaisons/etat → HTTP ${rep.status()}`);
    const j = (await rep.json().catch(() => null)) as { crm?: boolean; eteintes?: string[]; payant?: boolean; connexion?: boolean } | null;
    if (!j) throw new NonAbouti('Prospection : état des liaisons illisible');
    if (j.eteintes?.includes('crm')) throw new Error('désaccord : le Hub dit la paire allumée, Prospection la dit éteinte');
    if (!j.crm) {
      throw new NonAbouti(`le Hub sert ${PAIRE_PROSPECTION_CRM} (allumée) mais Prospection n'affiche pas « Envoyer au CRM » pour cette organisation : drapeau ATLAS_LIAISONS (en prod « crm=<organisations nommées> », jamais « * ») ou rôle en lecture seule. Plan payant : ${j.payant ? 'oui' : 'non'}.`);
    }
    if (!j.connexion) throw new NonAbouti("bouton affiché par Prospection, mais l'état de la paire n'a pas pu être relu au Hub (poignée absente) : envoi non éprouvé");
    return `${PAIRE_PROSPECTION_CRM} allumée au Hub et à l'écran, « Envoyer au CRM » proposé par Prospection (plan payant : ${j.payant ? 'oui' : 'non'}) ; geste d'envoi non joué`;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
