/**
 * Suspendre une organisation, puis retirer un membre (VER-245, parente 27/11 : « perd VRAIMENT l'accès dans toutes les apps ») : ce que chacun
 * tenait DÉJÀ dans Mail, Prospection et Academy se ferme, sondé 65 s par porte ; l'organisation d'à côté ne bouge pas ; la reprise rend tout.
 * Le CRM (cas 34) et Analytics (cas 38) ont leur propre cas ; la porte MCP, le cas 21 ; le retrait dans Mail et Prospection, le cas 37.
 *   Portes : Mail, jeton de session (liste des contacts) ; Prospection, session (l'espace dans /api/me) et une donnée de l'espace ;
 *   Academy, la page d'un cours ouverte par la session (lue = 200 sans la coquille « Espace suspendu » ; un renvoi ou la coquille = fermée).
 * Comptes et organisations de test, retirés par la batterie ; prod seulement (le Hub de staging n'a pas Academy).
 * NON SONDÉ : clés API d'espace (convenu, dites par le retrait), flux en direct et IMAP de Mail (cas 37).
 * Épreuves : `SSO_SABOTAGE=suspension-sessions` ne suspend pas ; `retrait-academy` ne retire pas : le cas doit échouer.
 */
import { expect, type Browser, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin, adminOk, appelAcademy, lookup, marquerTest } from './lib/hub-admin';
import { creerCompteProuve, ouvrirApp, type Compte } from './lib/parcours';

const ACADEMY_URL = process.env.ACADEMY_URL || 'https://academy.app.veridian.site';
const COURS = '/cours/environnement/dossier-au-tresor';
const DUREE = 65_000;
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
type Json = any;

const jetonMail = async (ctx: BrowserContext): Promise<string | null> => {
  const page = await ctx.newPage();
  await page.goto(`${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL.notifuse}/console/`)}`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForFunction(() => Boolean(localStorage.getItem('auth_token')), undefined, { timeout: 45_000 }).catch(() => undefined);
  const j = await page.evaluate(() => localStorage.getItem('auth_token')).catch(() => null);
  await page.close();
  return j;
};

/** Entrée à Academy par le rebond du Hub ; rend le code du refus s'il y en a un. */
async function entrerAcademy(ctx: BrowserContext): Promise<string | null> {
  const page = await ctx.newPage();
  try {
    await page.goto(`${HUB_URL}/login?next=${encodeURIComponent(`${ACADEMY_URL}/`)}`, { waitUntil: 'domcontentloaded' });
    const cible = new URL(ACADEMY_URL).host;
    await page.waitForURL((u) => u.host === cible || /\/auth\/bounce\/error/.test(u.pathname), { timeout: 60_000 });
    const u = new URL(page.url());
    return /\/auth\/bounce\/error/.test(u.pathname) ? (u.searchParams.get('code') ?? 'refus') : null;
  } finally {
    await page.close();
  }
}

type Session = { nom: string; c: Compte; ctx: BrowserContext; jeton: string; mail: string; espace: string; dossier: string; academy: boolean };
type Porte = 'mail' | 'prospection_espace' | 'prospection_donnee' | 'academy';

const lit: Record<Porte, (s: Session) => Promise<boolean>> = {
  mail: async (s) => (await fetch(`${APP_URL.notifuse}/api/contacts.list?workspace_id=${s.mail}&limit=1`, { headers: { Authorization: `Bearer ${s.jeton}` }, signal: AbortSignal.timeout(15_000) })).status === 200,
  prospection_espace: async (s) => (((await (await s.ctx.request.get(`${APP_URL.prospection}/api/me`, { timeout: 15_000 })).json().catch(() => null)) as Json)?.workspaces ?? []).some((w: { id: string }) => w.id === s.espace),
  prospection_donnee: async (s) => (await (await s.ctx.request.post(`${APP_URL.prospection}/api/atlas/lister_segments_atlas`, { data: {}, timeout: 15_000 })).text()).includes(s.dossier),
  // 200 ne suffit pas (27/11) : suspendue, Academy répond 200 avec la coquille « Espace suspendu », sans le cours. Lu = 200 ET pas cette coquille.
  academy: async (s) => { const r = await s.ctx.request.get(`${ACADEMY_URL}${COURS}`, { maxRedirects: 0, timeout: 20_000 }); return r.status() === 200 && !(await r.text()).includes('Espace suspendu'); },
};

/** Sonde chaque porte jusqu'à `DUREE` : rend, par porte, le dernier instant (ms après t0) où elle a lu ; 0 = jamais lue après t0. */
async function sonder(sessions: Session[], portes: (s: Session) => Porte[], t0: number): Promise<Record<string, number>> {
  const dernier: Record<string, number> = {};
  await Promise.all(sessions.flatMap((s) => portes(s).map(async (p) => {
    const cle = `${s.nom}.${p}`;
    dernier[cle] = 0;
    while (Date.now() - t0 < DUREE) {
      const t = Date.now();
      if (await lit[p](s).catch(() => false)) dernier[cle] = Math.max(1, t - t0);
      await pause(1_500);
    }
  })));
  return dernier;
}

cas(null, 'suspension puis retrait : ce que chacun tenait déjà dans Mail, Prospection et Academy se ferme, l\'organisation d\'à côté ne bouge pas', async ({ browser }: { browser: Browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (Academy)');
  const ouverts: BrowserContext[] = [];
  try {
    const P = await creerCompteProuve(browser, 'sspprop');
    const M = await creerCompteProuve(browser, 'sspmembre', undefined, true);
    const W = await creerCompteProuve(browser, 'ssptemoin');
    const T = (await lookup(P.email)).json?.tenants?.[0] as { id: string; notifuseWorkspaceSlug?: string } | undefined;
    const TW = (await lookup(W.email)).json?.tenants?.[0] as { id: string; notifuseWorkspaceSlug?: string } | undefined;
    if (!T?.notifuseWorkspaceSlug || !TW?.notifuseWorkspaceSlug) throw new NonAbouti('propriétaire ou témoin sans espace Mail');
    await marquerTest(T.id);
    await marquerTest(TW.id);
    const NOM = `TEST suspension ${Date.now().toString(36)}`;
    const r = await admin<{ emissions: { app: string; etat: string }[] }>('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: NOM, modules: ['prospection', 'notifuse'] });
    expect(r.json.emissions?.map((e) => [e.app, e.etat]).sort(), JSON.stringify(r.json).slice(0, 300)).toEqual([['notifuse', 'applique'], ['prospection', 'applique']]);
    const a = await admin<{ organisation?: { app: string; etat: string; detail?: string }[] }>('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
    expect(a.json.organisation?.every((e) => e.etat === 'applique' && !e.detail), JSON.stringify(a.json).slice(0, 400)).toBe(true);

    // Academy : ouverte à l'organisation par la route d'administration (comme les cas 50 et 56), le membre y entre par sync-member (cas 21).
    await adminOk('POST', 'tenants/app-access', { user_email: P.email, app: 'academy', enabled: true });
    const o = await adminOk<{ apps: { app: string; etat: string; detail?: string }[] }>('POST', `tenants/${T.id}/ouvrir`, { apps: ['academy'] });
    if (o.apps.find((x) => x.app === 'academy')?.etat !== 'ouverte') throw new NonAbouti(`Academy non ouverte : ${JSON.stringify(o.apps).slice(0, 200)}`);
    const sm = await appelAcademy(`/api/tenants/${T.id}/sync-member`, { hub_user_id: M.hubUserId, email: M.email, role: 'member', email_proven: true, joined_at: new Date().toISOString() });
    if (!sm.ok) throw new NonAbouti(`Academy : membre non entré, HTTP ${sm.status}`);
    // Academy est réservée PAR PERSONNE (rebond : `getEnabledGatedApps`), même pour un membre d'une organisation où elle est ouverte.
    const am = await admin<Json>('POST', 'tenants/app-access', { user_email: M.email, app: 'academy', enabled: true });
    if (am.status !== 200) throw new NonAbouti(`Academy : membre non activé au Hub, HTTP ${am.status} ${JSON.stringify(am.json).slice(0, 160)}`);

    const entrer = async (nom: string, c: Compte, mail: string, academy: boolean): Promise<Session> => {
      const ctx = await browser.newContext({ storageState: c.etat as never });
      ouverts.push(ctx);
      let me: { workspaces?: { id: string }[] } | null = null;
      for (let i = 0; i < 3 && !me?.workspaces?.length; i++) {
        if (i) await pause(35_000); // anti-boucle du rebond : 30 s
        await ouvrirApp(ctx, 'prospection');
        me = await (await ctx.request.get(`${APP_URL.prospection}/api/me`)).json().catch(() => null);
      }
      const jeton = await jetonMail(ctx);
      const refusAcademy = academy ? await entrerAcademy(ctx) : null;
      if (!jeton || !me?.workspaces?.length || refusAcademy) throw new NonAbouti(`${nom} : entrée incomplète, mail ${Boolean(jeton)}, prospection ${me?.workspaces?.length ?? 0}, academy ${refusAcademy ?? 'ok'}`);
      return { nom, c, ctx, jeton, mail, espace: '', dossier: '', academy };
    };
    const sP = await entrer('proprietaire', P, T.notifuseWorkspaceSlug, true);
    const sM = await entrer('membre', M, T.notifuseWorkspaceSlug, true);
    const sW = await entrer('temoin', W, TW.notifuseWorkspaceSlug, false);
    const mesP = (((await (await sP.ctx.request.get(`${APP_URL.prospection}/api/me`)).json()) as Json).workspaces as { id: string }[]).map((w) => w.id);
    const commun = (((await (await sM.ctx.request.get(`${APP_URL.prospection}/api/me`)).json()) as Json).workspaces as { id: string }[]).map((w) => w.id).find((x) => mesP.includes(x));
    const espaceW = (((await (await sW.ctx.request.get(`${APP_URL.prospection}/api/me`)).json()) as Json).workspaces as { id: string }[])[0]?.id;
    if (!commun || !espaceW) throw new NonAbouti('Prospection : pas d\'espace commun au propriétaire et au membre, ou témoin sans espace');
    for (const [s, e] of [[sP, commun], [sM, commun], [sW, espaceW]] as const) s.espace = e;
    // Une donnée de chaque espace, posée par son propriétaire : la lire prouve l'espace, pas seulement la session.
    for (const s of [sP, sW]) {
      s.dossier = `${NOM} ${s.nom}`;
      const d = await s.ctx.request.post(`${APP_URL.prospection}/api/atlas/creer_dossier`, { data: { nom: s.dossier }, timeout: 15_000 });
      if (!d.ok()) throw new NonAbouti(`Prospection : dossier non créé (${s.nom}), HTTP ${d.status()}`);
    }
    sM.dossier = sP.dossier;

    const portesDe = (s: Session): Porte[] => ['mail', 'prospection_espace', 'prospection_donnee', ...(s.academy ? ['academy' as const] : [])];
    const fermeesAvant = async (s: Session) => { const f: string[] = []; for (const p of portesDe(s)) if (!(await lit[p](s).catch(() => false))) f.push(p); return f; };
    for (const s of [sP, sM, sW]) expect(await fermeesAvant(s), `contrôle positif, ${s.nom} : tout lit avant la suspension`).toEqual([]);

    // 1. Suspension.
    const susp = process.env.SSO_SABOTAGE === 'suspension-sessions' ? { apps: [] } : (await admin<Json>('POST', `tenants/${T.id}/suspension`, { suspendre: true, motif: 'test' })).json;
    const issueS = (susp.apps as { app: string; etat: string; detail?: string }[]).map((x) => `${x.app}=${x.etat}${x.detail ? ` (${x.detail})` : ''}`).join(', ');
    const t0 = Date.now();
    const apresS = await sonder([sP, sM, sW], portesDe, t0);
    const ouvertesS = Object.entries(apresS).filter(([k, v]) => !k.startsWith('temoin.') && v > 0).map(([k, v]) => `${k} lue à ${v} ms`);
    const temoinS = Object.entries(apresS).filter(([k, v]) => k.startsWith('temoin.') && v === 0).map(([k]) => k);

    // 2. Reprise : tout se rouvre, sans nouvelle connexion.
    const reprise = (await admin<Json>('POST', `tenants/${T.id}/suspension`, { suspendre: false })).json;
    await pause(3_000);
    const fermeesReprise: string[] = [];
    for (const s of [sP, sM]) for (const p of portesDe(s)) {
      let ok = false;
      for (let i = 0; i < 10 && !ok; i++) { ok = await lit[p](s).catch(() => false); if (!ok) await pause(3_000); }
      if (!ok) fermeesReprise.push(`${s.nom}.${p}`);
    }

    // 3. Retrait du membre : il perd tout, le propriétaire garde tout.
    const ret = process.env.SSO_SABOTAGE === 'retrait-academy' ? { apps: [] } : (await admin<Json>('POST', `tenants/${T.id}/remove-member`, { hub_user_id: M.hubUserId })).json;
    const issueR = (ret.apps as { app: string; etat: string; detail?: string }[]).map((x) => `${x.app}=${x.etat}${x.detail ? ` (${x.detail})` : ''}`).join(', ');
    const t1 = Date.now();
    const apresR = await sonder([sP, sM], portesDe, t1);
    const ouvertesR = Object.entries(apresR).filter(([k, v]) => k.startsWith('membre.') && v > 0).map(([k, v]) => `${k} lue à ${v} ms`);
    const proprioR = Object.entries(apresR).filter(([k, v]) => k.startsWith('proprietaire.') && v === 0).map(([k]) => k);

    // Les portes en défaut d'abord : le résultat de la batterie ne garde que le début du message (27/11, porte d'Academy illisible).
    const defauts = [...ouvertesS.map((x) => `suspendu, encore lu : ${x}`), ...temoinS.map((x) => `témoin fermé : ${x}`), ...fermeesReprise.map((x) => `non rendu à la reprise : ${x}`),
      ...ouvertesR.map((x) => `retiré, encore lu : ${x}`), ...proprioR.map((x) => `propriétaire fermé au retrait : ${x}`)];
    expect({ suspension_ouvertes: ouvertesS, temoin_ferme: temoinS, reprise_fermees: fermeesReprise, retrait_ouvertes: ouvertesR, proprietaire_ferme: proprioR },
      `${defauts.join(' ; ') || 'aucun défaut'} || suspension [${issueS}] ; reprise [${(reprise.apps ?? []).map((x: Json) => `${x.app}=${x.etat}`).join(', ')}] ; retrait [${issueR}]`)
      .toEqual({ suspension_ouvertes: [], temoin_ferme: [], reprise_fermees: [], retrait_ouvertes: [], proprietaire_ferme: [] });
    return `suspension [${issueS}] : ${Object.keys(apresS).filter((k) => !k.startsWith('temoin.')).length} portes fermées dès la réponse, témoin ouvert ; reprise rend tout ; retrait [${issueR}] : ${ouvertesR.length} porte du membre ouverte`;
  } finally {
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 900_000 });
