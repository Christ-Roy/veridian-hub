/**
 * Parcours navigateur communs : un vrai Chromium, le vrai chemin d'un utilisateur
 * (lien d'invitation, mot de passe, connexion Hub, rebond vers l'app).
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { APP_URL, DOMAINE_COMPTE, HUB_URL, PREFIXE_COMPTE, type AppKey } from './cibles';
import { NonAbouti } from './etat';
import { invite, lookup, usersCreate } from './hub-admin';
import { RUN_DIR } from './versions';

export const ID_RUN =
  process.env.SSO_RUN_ID || `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
// Un registre par Hub : un passage staging ne doit pas oublier, ni chercher, les comptes de la prod.
const SUFFIXE_HUB = /staging/.test(HUB_URL) ? '-staging' : '';
const REGISTRE = path.join(RUN_DIR, `comptes${SUFFIXE_HUB}.jsonl`);

export type Compte = {
  etiquette: string;
  email: string;
  nom: string;
  motDePasse: string;
  hubUserId: string | null;
  tenantId: string | null;
  etat: any; // storageState Playwright : session Hub ouverte
};

/** Chaque compte créé est noté AVANT usage : le nettoyage retrouve les siens, et seulement les siens. */
export function noter(email: string) {
  mkdirSync(RUN_DIR, { recursive: true });
  appendFileSync(REGISTRE, JSON.stringify({ email, run: ID_RUN, a: new Date().toISOString() }) + '\n');
}

export function comptesNotes(): string[] {
  if (!existsSync(REGISTRE)) return [];
  return readFileSync(REGISTRE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).email as string)
    .filter((e) => e.startsWith(PREFIXE_COMPTE) && e.endsWith(`@${DOMAINE_COMPTE}`));
}

function retirerDe(fichier: string, email: string) {
  if (!existsSync(fichier)) return;
  const gardees = readFileSync(fichier, 'utf8')
    .split('\n')
    .filter((l) => l && JSON.parse(l).email !== email);
  writeFileSync(fichier, gardees.length ? `${gardees.join('\n')}\n` : '');
}

export const oublierCompte = (email: string) => retirerDe(REGISTRE, email);

/** Les comptes Rybbit ont leur registre : `monde` repart à zéro à chaque lancement, pas eux. */
const REGISTRE_RYBBIT = path.join(RUN_DIR, `comptes-rybbit${SUFFIXE_HUB}.jsonl`);

export function noterRybbit(email: string) {
  mkdirSync(RUN_DIR, { recursive: true });
  appendFileSync(REGISTRE_RYBBIT, JSON.stringify({ email, run: ID_RUN }) + '\n');
}

export function comptesRybbitNotes(): string[] {
  if (!existsSync(REGISTRE_RYBBIT)) return [];
  return readFileSync(REGISTRE_RYBBIT, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).email as string);
}

/** Espaces Twenty de test : retirés au nettoyage, le `deleted` du Hub les laisserait. */
const REGISTRE_TWENTY = path.join(RUN_DIR, `espaces-twenty${SUFFIXE_HUB}.jsonl`);

export function noterEspaceTwenty(email: string, tenantId: string) {
  mkdirSync(RUN_DIR, { recursive: true });
  appendFileSync(REGISTRE_TWENTY, JSON.stringify({ email, tenantId }) + '\n');
}

export function espacesTwenty(email: string): string[] {
  if (!existsSync(REGISTRE_TWENTY)) return [];
  return readFileSync(REGISTRE_TWENTY, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { email: string; tenantId: string })
    .filter((l) => l.email === email)
    .map((l) => l.tenantId);
}

export const oublierEspacesTwenty = (email: string) => retirerDe(REGISTRE_TWENTY, email);

/** Workspaces Notifuse : notés à la création, un compte supprimé en cours de scénario ne les perd pas. */
const REGISTRE_WORKSPACES = path.join(RUN_DIR, `workspaces-notifuse${SUFFIXE_HUB}.jsonl`);

export function noterWorkspace(email: string, id: string) {
  mkdirSync(RUN_DIR, { recursive: true });
  appendFileSync(REGISTRE_WORKSPACES, JSON.stringify({ email, id }) + '\n');
}

export function workspacesNotes(email: string): string[] {
  if (!existsSync(REGISTRE_WORKSPACES)) return [];
  return readFileSync(REGISTRE_WORKSPACES, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { email: string; id: string })
    .filter((l) => l.email === email)
    .map((l) => l.id);
}

export const oublierWorkspaces = (email: string) => retirerDe(REGISTRE_WORKSPACES, email);

export const oublierRybbit = (email: string) => retirerDe(REGISTRE_RYBBIT, email);

function nouveauMdp() {
  return `Tst-${randomBytes(9).toString('base64url')}A9z`;
}

export async function attendreSessionHub(ctx: BrowserContext, email: string, ms = 60_000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    // un accroc réseau passager (ECONNRESET) n'est pas une réponse : on réessaie
    const r = await ctx.request.get(`${HUB_URL}/api/auth/session`).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (j?.user?.email?.toLowerCase() === email.toLowerCase()) return true;
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  return false;
}

export async function connexionHub(page: Page, email: string, motDePasse: string) {
  await page.goto(`${HUB_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type=email], input[name=email]').first().fill(email);
  await page.locator('input[type=password]').first().fill(motDePasse);
  await page.getByRole('button', { name: /^Se connecter$/i }).click();
}

/**
 * Compte PROUVÉ : le chemin réel d'un client invité. Le lien d'invitation (envoyé à
 * cette adresse) est la preuve ; l'activation pose le mot de passe, ouvre la session
 * Hub et provisionne les apps. Aucun mail ne part (`sendEmail: false`).
 */
export async function creerCompteProuve(browser: Browser, etiquette: string): Promise<Compte> {
  const email = `${PREFIXE_COMPTE}${ID_RUN}-${etiquette}@${DOMAINE_COMPTE}`;
  const nom = `TEST SYSTEME SSO ${etiquette}`;
  const motDePasse = nouveauMdp();
  noter(email);
  await usersCreate(email, nom);
  // Le Hub staging n'a que Twenty en face : ni Prospection ni Notifuse à provisionner.
  const surStaging = /staging/.test(HUB_URL);
  const inv = await invite(email, surStaging ? ['hub'] : ['hub', 'prospection', 'notifuse', 'analytics'], 'TEST SYSTEME SSO');
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(inv.invite_url, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Activer mon compte/i }).click();
    await page.getByLabel('Mot de passe', { exact: true }).fill(motDePasse);
    await page.getByLabel('Confirmation').fill(motDePasse);
    await page.getByRole('button', { name: /Créer mon accès/i }).click();
    let session = await attendreSessionHub(ctx, email, 45_000);
    if (!session) {
      // L'activation n'a pas ouvert la session toute seule : connexion normale.
      await connexionHub(page, email, motDePasse);
      session = await attendreSessionHub(ctx, email, 30_000);
    }
    if (!session) throw new NonAbouti(`compte de test ${etiquette} : aucune session Hub après l'activation`);
    // Provisionnement des apps : on attend qu'il soit visible côté Hub.
    let u: any = null;
    for (let i = 0; i < 40; i++) {
      u = (await lookup(email)).json;
      if (surStaging ? u?.user?.email_verified : u?.tenants?.[0]?.prospectionProvisionedAt && u?.tenants?.[0]?.notifuseWorkspaceSlug) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!surStaging && !u?.tenants?.[0]) throw new NonAbouti(`compte de test ${etiquette} : tenant non provisionné après 60 s`);
    for (const t of (u?.tenants ?? []) as { notifuseWorkspaceSlug?: string }[]) {
      if (t.notifuseWorkspaceSlug) noterWorkspace(email, t.notifuseWorkspaceSlug);
    }
    if (!u.user?.email_verified) {
      throw new NonAbouti(`compte de test ${etiquette} : adresse toujours non prouvée après l'invitation`);
    }
    return {
      etiquette,
      email,
      nom,
      motDePasse,
      hubUserId: u.user.supabase_user_id ?? null,
      tenantId: u.tenants?.[0]?.id ?? null,
      etat: await ctx.storageState(),
    };
  } finally {
    await ctx.close();
  }
}

/**
 * Compte NON PROUVÉ : inscription publique (mot de passe posé, adresse jamais confirmée).
 * C'est le scénario d'attaque : quelqu'un s'inscrit au nom d'une adresse qui n'est pas la sienne.
 */
export async function creerCompteNonProuve(browser: Browser, etiquette: string): Promise<Compte> {
  const email = `${PREFIXE_COMPTE}${ID_RUN}-${etiquette}@${DOMAINE_COMPTE}`;
  const motDePasse = nouveauMdp();
  noter(email);
  const ctx = await browser.newContext();
  try {
    const r = await ctx.request.post(`${HUB_URL}/api/auth/signup`, {
      data: { email, password: motDePasse },
    });
    // 409 = inscription déjà faite par une tentative précédente de CETTE run : on reprend le compte
    if (r.status() >= 300 && r.status() !== 409) {
      throw new NonAbouti(`inscription du compte non prouvé refusée : HTTP ${r.status()} ${(await r.text()).slice(0, 120)}`);
    }
    const u = (await lookup(email)).json;
    if (u?.user?.email_verified) {
      throw new NonAbouti('le compte « non prouvé » est déjà prouvé côté Hub : le cas ne peut pas être joué');
    }
    const page = await ctx.newPage();
    await connexionHub(page, email, motDePasse);
    const ouverte = await attendreSessionHub(ctx, email, 20_000);
    return {
      etiquette,
      email,
      nom: email,
      motDePasse,
      hubUserId: u?.user?.supabase_user_id ?? null,
      tenantId: null,
      // null = le Hub a refusé la session par mot de passe : le cas se rejoue par impersonation
      etat: ouverte ? await ctx.storageState() : null,
    };
  } finally {
    await ctx.close();
  }
}

export type Atterrissage = {
  app: AppKey;
  url: string;
  hote: string;
  chemin: string;
  texte: string;
  formulaireMotDePasse: boolean;
  lienUnique: string | null;
  navigations: string[];
};

const hoteDe = (u: string) => new URL(u).host;

/**
 * Le geste utilisateur : « ouvrir <app> » depuis une session Hub. On part de la page
 * de connexion du Hub avec `next=<app>` (le contrat §6bis, couche 4), sans rien saisir.
 */
export async function ouvrirApp(ctx: BrowserContext, app: AppKey): Promise<Atterrissage> {
  const page = await ctx.newPage();
  const hoteApp = hoteDe(APP_URL[app]);
  const navigations: string[] = [];
  let lienUnique: string | null = null;
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations.push(f.url());
  });
  page.on('request', (r) => {
    const u = r.url();
    if (!lienUnique && hoteDe(u) === hoteApp && /[?&](token|t)=/.test(u)) lienUnique = u;
  });
  await page
    .goto(`${HUB_URL}/login?next=${encodeURIComponent(APP_URL[app] + '/')}`, { waitUntil: 'domcontentloaded' })
    .catch(() => {});
  await page
    .waitForURL(
      (u) => u.host === hoteApp || /\/dashboard|\/auth\/bounce\/error/.test(u.pathname),
      { timeout: 30_000 },
    )
    .catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(2_000);
  const u = new URL(page.url());
  const texte = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);
  const formulaireMotDePasse = (await page.locator('input[type=password]').count().catch(() => 0)) > 0;
  const res: Atterrissage = {
    app,
    url: page.url(),
    hote: u.host,
    chemin: u.pathname,
    texte,
    formulaireMotDePasse,
    lienUnique,
    navigations,
  };
  await page.close();
  return res;
}

/** Ouvre un lien tel quel dans un contexte vierge et rend ce qu'on y voit. */
export async function ouvrirLien(browser: Browser, lien: string, app: AppKey | 'hub') {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(lien, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    const base = app === 'hub' ? HUB_URL : APP_URL[app];
    const session = await sessionApp(ctx, app, base);
    return {
      url: page.url(),
      texte: (await page.locator('body').innerText().catch(() => '')).slice(0, 3000),
      session,
    };
  } finally {
    await ctx.close();
  }
}

/** E-mail de la session ouverte dans l'app (Auth.js) ou null si aucune session. */
export async function sessionApp(ctx: BrowserContext, app: AppKey | 'hub', base?: string) {
  const b = base ?? (app === 'hub' ? HUB_URL : APP_URL[app]);
  if (app === 'notifuse' || app === 'analytics' || app === 'twenty') return null; // lu par la page, pas par Auth.js
  const r = await ctx.request.get(`${b}/api/auth/session`).catch(() => null);
  const j = await r?.json().catch(() => null);
  return (j?.user as { email?: string; id?: string } | undefined) ?? null;
}

/** Page réservée aux connectés, celle qu'on demande pour prouver le retour « sur la page demandée ». */
export const PAGE_PROTEGEE: Record<AppKey, string> = {
  prospection: '/prospects',
  notifuse: '/console/',
  analytics: '/',
  twenty: '/settings/profile',
};

export type VueApp = {
  connecte: boolean;
  hote: string;
  chemin: string;
  /** Départs vers le rebond automatique : un seul attendu, jamais une rafale. */
  rebondsAuto: number;
};

/**
 * La session telle que l'app la relit côté serveur, depuis la page ouverte. `no-store` : Prospection
 * met certaines réponses en cache 30 s. Twenty n'a pas encore de lecture : `undefined` = non lu.
 */
async function sessionLue(page: Page, app: AppKey): Promise<boolean | undefined> {
  const lire = (chemin: string, jeton: string | null = null) =>
    page.evaluate(
      async ([c, j]) => {
        const r = await fetch(c as string, {
          cache: 'no-store',
          headers: j ? { Authorization: `Bearer ${j}` } : {},
        });
        return { status: r.status, corps: await r.json().catch(() => null) };
      },
      [chemin, jeton],
    );
  if (app === 'prospection') return Boolean((await lire('/api/auth/session')).corps?.user?.email);
  if (app === 'analytics') return Boolean((await lire('/api/auth/get-session')).corps?.user?.email);
  if (app === 'notifuse') {
    const jeton = await page.evaluate(() => localStorage.getItem('auth_token'));
    if (!jeton) return false;
    return (await lire('/api/user.me', jeton)).status === 200;
  }
  if (app === 'twenty') {
    const lu = await page.evaluate(async () => {
      const r = await fetch('/metadata', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-twenty-session-cookie': '1' },
        body: JSON.stringify({ query: '{currentUser{email}}' }),
      });
      return (await r.json().catch(() => null)) as { data?: { currentUser?: { email?: string } } } | null;
    });
    return Boolean(lu?.data?.currentUser?.email);
  }
  return undefined;
}

/** Le clic « Se déconnecter » de chaque app, celui qui doit interdire la reconnexion silencieuse. */
export async function seDeconnecterDeApp(ctx: BrowserContext, app: AppKey, hote?: string): Promise<void> {
  const page = await ctx.newPage();
  try {
    if (app === 'notifuse') {
      await page.goto(`${APP_URL.notifuse}/console/logout`, { waitUntil: 'domcontentloaded' });
    } else {
      // Twenty : la session vit sur l'hôte de l'espace, pas sur le domaine nu.
      const base = app === 'twenty' && hote ? `https://${hote}` : APP_URL[app];
      await page.goto(`${base}${{ prospection: PAGE_PROTEGEE.prospection, analytics: '/settings/account', twenty: '/settings/profile', notifuse: '' }[app]}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      const bouton =
        app === 'prospection'
          ? page.locator('[title^="Se déconnecter"]')
          : app === 'twenty'
            ? page.locator('#nav-item-logout')
            : page.getByText(/^(Sign out|Se déconnecter|Log ?out|Déconnexion)$/i);
      await bouton.first().click({ timeout: app === 'twenty' ? 60_000 : 20_000 });
    }
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
  } catch (e) {
    throw new NonAbouti(`bouton de déconnexion de ${app} introuvable : ${(e as Error).message.split('\n')[0]}`);
  } finally {
    await page.close();
  }
}

/**
 * Le geste réel : ouvrir une page de l'app dans ce navigateur, sans rien saisir, et regarder où l'on
 * finit, puis relire la session. Vaut quel que soit l'endroit où l'app la garde (cookie, localStorage).
 * Le rebond part souvent du client après chargement : on attend que l'adresse soit stable 6 s.
 */
export async function voirApp(ctx: BrowserContext, app: AppKey, chemin = PAGE_PROTEGEE[app]): Promise<VueApp> {
  const page = await ctx.newPage();
  let rebondsAuto = 0;
  page.on('request', (r) => {
    if (r.isNavigationRequest() && /\/api\/auth\/bounce\/prepare\?.*auto=1/.test(r.url())) rebondsAuto += 1;
  });
  try {
    await page.goto(`${APP_URL[app]}${chemin}`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    // Twenty recharge tout son front sur chaque hôte (9 à 14 s mesurées sous charge) : `/verify` est un
    // passage, jamais une arrivée, et une adresse stable 6 s n'y prouve rien.
    const stable = app === 'twenty' ? 20_000 : 6_000;
    const fin = Date.now() + 75_000;
    let vue = page.url();
    let depuis = Date.now();
    while (Date.now() < fin && (Date.now() - depuis < stable || new URL(page.url()).pathname === '/verify')) {
      await page.waitForTimeout(500);
      if (page.url() !== vue) {
        vue = page.url();
        depuis = Date.now();
      }
    }
    const u = new URL(page.url());
    // Twenty sert chaque espace sur `<slug>.crm.*`.
    const surApp = u.host === hoteDe(APP_URL[app]) || u.host.endsWith(`.${hoteDe(APP_URL[app])}`);
    const formulaire = (await page.locator('input[type=password]').count().catch(() => 0)) > 0;
    let connecte = surApp && !/login|signin|sign-in|welcome|session-ended|auth\//.test(u.pathname) && !formulaire;
    if (connecte) connecte = (await sessionLue(page, app).catch(() => false)) ?? true;
    return { connecte, hote: u.host, chemin: u.pathname, rebondsAuto };
  } finally {
    await page.close();
  }
}
