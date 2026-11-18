/**
 * Porte MCP (docs/CONTRAT-MCP.md) : le parcours d'un vrai client IA sur ce qui est servi.
 * Découverte (401 + métadonnées), enregistrement dynamique, consentement dans le navigateur avec la
 * session Hub, échange PKCE, initialize, trois outils, recherche puis exécution de hub.mon_compte sur
 * le bon compte, rotation (le renouvellement rejoué coupe la connexion). Épreuve : `SSO_SABOTAGE=mcp`
 * (mauvais vérificateur PKCE : l'échange doit échouer).
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { expect } from '@playwright/test';

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerAnalyticsAuHub, activerTwentyAuHub, admin, rybbitCompte } from './lib/hub-admin';
import { assurerRybbit } from './lib/monde';
import { creerCompteProuve, noterEspaceTwenty } from './lib/parcours';

const RETOUR = 'http://127.0.0.1:53682/callback';
/**
 * Outil de lecture déterministe imposé par app, quand l'app le désigne (09/11) : Prospection (Atlas) et
 * Twenty, dont aucun outil en lecture n'est exécutable sans données. Les autres apps : choix automatique.
 */
const OUTIL_TEMOIN: Record<string, { local: string; args: Record<string, unknown> }> = {
  prospection: { local: 'explorer_marche', args: { filtre: { conditions: [{ champ: 'departement', op: 'dans', valeur: ['69'] }] }, par_page: 5 } },
  twenty: { local: 'find_many_people', args: { limit: 1, select: ['id'] } },
};
const JETON = process.env.JETON_MCP || path.join(os.homedir(), '.claude/skills/hub-admin/scripts/jeton-mcp.sh');

async function form(chemin: string, p: Record<string, string>) {
  return fetch(`${HUB_URL}${chemin}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(p).toString(),
    signal: AbortSignal.timeout(20_000),
  });
}

let id = 0;
async function rpc(jeton: string, method: string, params: Record<string, unknown> = {}) {
  const r = await fetch(`${HUB_URL}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${jeton}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
}

cas(null, 'porte MCP : un client IA s\'enregistre, obtient le consentement, appelle un outil sur le bon compte', async ({ browser }) => {
  // Découverte : sans jeton, la porte dit où s'autoriser.
  const nu = await fetch(`${HUB_URL}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  expect(nu.status, 'porte sans jeton').toBe(401);
  expect(nu.headers.get('www-authenticate') ?? '').toContain('resource_metadata=');
  const prm = await (await fetch(`${HUB_URL}/.well-known/oauth-protected-resource`)).json();
  expect(prm.resource).toBe(`${HUB_URL}/api/mcp`);
  const as = await (await fetch(`${HUB_URL}/.well-known/oauth-authorization-server`)).json();
  expect(as.code_challenge_methods_supported).toEqual(['S256']);
  const jwks = await (await fetch(`${HUB_URL}/.well-known/jwks.json`)).json();
  expect(jwks.keys?.length, 'clé publique servie aux apps').toBe(1);

  const reg = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'TEST SYSTEME SSO', redirect_uris: [RETOUR], token_endpoint_auth_method: 'none' }),
  });
  expect(reg.status, 'enregistrement dynamique').toBe(201);
  const client = (await reg.json()).client_id as string;

  const E = await creerCompteProuve(browser, 'mcp');
  if (!E.hubUserId || !E.tenantId) throw new NonAbouti('compte de test sans hub_user_id ni tenant');
  // Toutes les apps du registre doivent être ouvertes à ce compte : comptes Analytics et CRM par
  // leurs chemins normaux (notés pour le nettoyage AVANT leur création).
  assurerRybbit(E);
  rybbitCompte('lier', E.email, E.hubUserId);
  await activerAnalyticsAuHub(E.email);
  noterEspaceTwenty(E.email, E.tenantId);
  await activerTwentyAuHub(E.email);
  const inscrites = ((await admin<{ apps: { appKey: string; enabled: boolean; mcpUrl: string }[] }>('GET', 'mcp-apps')).json?.apps ?? [])
    .filter((a) => a.enabled);
  const registre = inscrites.map((a) => a.appKey).sort();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(8).toString('hex');
  const url = `${as.authorization_endpoint}?${new URLSearchParams({
    response_type: 'code',
    client_id: client,
    redirect_uri: RETOUR,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    scope: 'veridian',
    resource: prm.resource,
  })}`;

  // Sans session : renvoyé à la connexion, la demande conservée.
  const anonyme = await browser.newContext();
  const pa = await anonyme.newPage();
  await pa.goto(url);
  expect(pa.url(), 'sans session : connexion d\'abord').toContain('/login?callbackUrl=');
  await anonyme.close();

  const ctx = await browser.newContext({ storageState: E.etat });
  let retour = '';
  try {
    const page = await ctx.newPage();
    // Ce que le navigateur reçoit de la soumission : rendu dans l'erreur si le retour n'arrive pas.
    const vu: string[] = [];
    page.on('response', (r) => {
      if (!r.url().includes('/oauth/authorize')) return;
      const loc = r.headers().location ?? '';
      vu.push(`${r.request().method()} ${r.status()} ${loc.slice(0, 80)}`);
      // Playwright n'intercepte pas la cible d'une redirection : le retour se lit dans le 303,
      // comme le serveur local d'un vrai client le recevrait.
      if (r.status() === 303 && loc.startsWith(RETOUR)) retour = loc;
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByText('TEST SYSTEME SSO', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Autoriser' }).click();
    try {
      await expect.poll(() => retour, { timeout: 20_000 }).not.toBe('');
    } catch {
      const texte = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(`consentement sans retour : réponses ${JSON.stringify(vu)} ; page ${page.url().slice(0, 120)} ; texte « ${texte} »`);
    }
  } finally {
    await ctx.close();
  }
  const r = new URL(retour);
  expect(r.searchParams.get('state')).toBe(state);
  expect(r.searchParams.get('iss')).toBe(as.issuer);
  const code = r.searchParams.get('code');
  if (!code) throw new NonAbouti(`consentement sans code : ${retour.slice(0, 200)}`);

  const tok = await form('/api/oauth/token', {
    grant_type: 'authorization_code',
    code,
    client_id: client,
    redirect_uri: RETOUR,
    code_verifier: process.env.SSO_SABOTAGE === 'mcp' ? randomBytes(32).toString('base64url') : verifier,
    resource: prm.resource,
  });
  expect(tok.status, 'échange du code (PKCE)').toBe(200);
  const t = await tok.json();

  const init = await rpc(t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  expect(init.json?.result?.serverInfo?.name).toBe('veridian');
  const liste = await rpc(t.access_token, 'tools/list');
  expect(liste.json.result.tools.map((x: { name: string }) => x.name)).toEqual(['chercher_outils', 'decrire_outil', 'executer_outil']);
  const trouve = JSON.parse((await rpc(t.access_token, 'tools/call', { name: 'chercher_outils', arguments: { besoin: 'mon compte' } })).json.result.content[0].text);
  expect(trouve.outils.map((o: { nom: string }) => o.nom)).toContain('hub.mon_compte');
  const compte = JSON.parse((await rpc(t.access_token, 'tools/call', { name: 'executer_outil', arguments: { nom: 'hub.mon_compte' } })).json.result.content[0].text);
  expect(compte.email, 'l\'outil agit sur le compte qui a consenti').toBe(E.email);

  // Fédération : chaque app ouverte au compte répond par la porte, avec ses outils, et un outil en
  // lecture seule s'exécute sur ce compte (valeurs de test : « test » pour un texte, ["id"] pour une
  // liste de champs). Rien n'est écrit chez l'app.
  const appsOuvertes = (trouve.apps as string[]).filter((a) => a !== 'hub');
  type Ligne = { app: string; statut: 'ok' | 'echec' | 'sans_outil_lecture'; outil: string; extrait: string; avec_espace?: string; regle_tenant?: string };
  const tableau: Ligne[] = (trouve.injoignables ?? []).map((i: { app: string; raison: string }) => ({ app: i.app, statut: 'echec' as const, outil: '-', extrait: i.raison }));
  const outilsChoisis: Record<string, { local: string; args: Record<string, unknown> }> = {};
  for (const app of appsOuvertes) {
    if (tableau.some((l) => l.app === app)) continue;
    const chercher = async (besoin: string) =>
      JSON.parse((await rpc(t.access_token, 'tools/call', { name: 'chercher_outils', arguments: { besoin, app } })).json.result.content[0].text).outils as { nom: string }[];
    // Les outils de lecture d'enregistrements d'abord (déterministes) ; une recherche externe n'est pas
    // un témoin de la chaîne Hub → app.
    const candidats = [...(await chercher('find list get people sites contacts entreprises')), ...(await chercher(''))];
    if (!candidats.length) {
      tableau.push({ app, statut: 'echec', outil: '-', extrait: 'aucun outil rendu' });
      continue;
    }
    let ligne: Ligne = { app, statut: 'sans_outil_lecture', outil: '-', extrait: `${candidats.length} outils, aucun en lecture seule exécutable sans données` };
    const lisibles: { nom: string; args: Record<string, unknown>; poids: number }[] = [];
    for (const o of candidats) {
      if (lisibles.some((l) => l.nom === o.nom)) continue;
      const d = JSON.parse((await rpc(t.access_token, 'tools/call', { name: 'decrire_outil', arguments: { nom: o.nom } })).json.result.content[0].text);
      if (d.annotations?.readOnlyHint !== true) continue;
      const requis = (d.parametres?.required ?? []) as string[];
      const props = (d.parametres?.properties ?? {}) as Record<string, { type?: string; items?: { type?: string } }>;
      const valeur = (k: string) => (props[k]?.type === 'string' ? 'test' : props[k]?.type === 'array' && props[k]?.items?.type === 'string' ? ['id'] : undefined);
      if (!requis.every((k) => valeur(k) !== undefined)) continue;
      // Poids : outil de recherche externe en dernier, puis le moins de paramètres.
      const externe = d.annotations?.openWorldHint === true || /help|doc|search_help/.test(o.nom);
      lisibles.push({ nom: o.nom, args: Object.fromEntries(requis.map((k) => [k, valeur(k)])), poids: (externe ? 100 : 0) + requis.length });
    }
    lisibles.sort((a, b) => a.poids - b.poids);
    const temoin = OUTIL_TEMOIN[app];
    if (temoin) lisibles.unshift({ nom: `${app}.${temoin.local}`, args: temoin.args, poids: -1 });
    for (const o of lisibles.slice(0, 1)) {
      const r = (await rpc(t.access_token, 'tools/call', { name: 'executer_outil', arguments: { nom: o.nom, arguments: o.args } })).json.result;
      const texte = String(r.content?.[0]?.text ?? '').replace(/\s+/g, ' ');
      const echecApplicatif = /"success":\s*false/.test(texte.slice(0, 40));
      ligne = { app, statut: r.isError || echecApplicatif ? 'echec' : 'ok', outil: o.nom, extrait: texte.slice(0, 140) };
      outilsChoisis[app] = { local: o.nom.slice(app.length + 1), args: o.args };
    }
    tableau.push(ligne);
  }

  // Avec l'espace choisi (tenant_id signé par la porte, appartenance vérifiée) : l'app doit servir cet
  // espace, donc l'avoir relié au tenant Hub du compte.
  const monEspace = (compte.espaces as { slug: string }[])[0]?.slug;
  for (const l of tableau) {
    const choisi = outilsChoisis[l.app];
    if (!choisi || !monEspace) continue;
    const r = (await rpc(t.access_token, 'tools/call', { name: 'executer_outil', arguments: { nom: `${l.app}.${choisi.local}`, arguments: choisi.args, espace: monEspace } })).json.result;
    const texte = String(r.content?.[0]?.text ?? '').replace(/\s+/g, ' ');
    l.avec_espace = r.isError ? `ECHEC : ${texte.slice(0, 120)}` : 'ok';
  }

  // Règle tenant_id du contrat, chez chaque app : un tenant_id relié à aucun espace rend 403
  // tenant_not_linked, jamais un repli silencieux ni un 401. Jeton signé par la clé du Hub, pour ce compte.
  for (const l of tableau) {
    const app = inscrites.find((a) => a.appKey === l.app);
    if (!app) continue;
    const jeton = execFileSync(JETON, [app.mcpUrl, E.hubUserId, E.email, randomUUID()], { encoding: 'utf8', timeout: 60_000 }).trim();
    const appelApp = async (method: string, params: Record<string, unknown>, sid?: string | null) => {
      const res = await fetch(app.mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${jeton}`, 'mcp-protocol-version': '2025-06-18', ...(sid ? { 'mcp-session-id': sid } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, sid: res.headers.get('mcp-session-id'), corps: (await res.text()).replace(/\s+/g, ' ') };
    };
    let rep = await appelApp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'batterie', version: '1' } });
    const choisi = outilsChoisis[l.app];
    if (rep.status === 200 && choisi) rep = await appelApp('tools/call', { name: choisi.local, arguments: choisi.args }, rep.sid);
    const conforme = rep.status === 403 && rep.corps.includes('tenant_not_linked');
    l.regle_tenant = conforme ? 'ok (403 tenant_not_linked)' : `NON CONFORME : HTTP ${rep.status} ${rep.corps.slice(0, 120)}`;
  }
  // Tableau complet, lisible même en échec (le rapport de la batterie tronque le détail).
  writeFileSync(path.join(__dirname, '.run', 'mcp-federation.json'), JSON.stringify(tableau, null, 2));
  expect(tableau.map((l) => l.app).sort(), 'chaque app du registre passe par la porte').toEqual(registre);
  const preuves = tableau.map((l) => `${l.app}=${l.statut}${l.outil !== '-' ? `(${l.outil})` : ''}`);
  expect(tableau.filter((l) => l.statut === 'echec'), `apps en échec par la porte : ${JSON.stringify(tableau)}`).toEqual([]);
  expect(tableau.filter((l) => l.avec_espace !== 'ok').map((l) => `${l.app} ${l.avec_espace}`), 'espace choisi servi par chaque app').toEqual([]);
  expect(tableau.filter((l) => !l.regle_tenant?.startsWith('ok')).map((l) => `${l.app} ${l.regle_tenant}`), 'règle tenant_id du contrat').toEqual([]);

  // Rotation : le nouveau marche, l'ancien rejoué coupe toute la connexion.
  const t2 = await (await form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client })).json();
  expect((await rpc(t2.access_token, 'ping')).status).toBe(200);
  expect((await form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client })).status).toBe(400);
  expect((await rpc(t2.access_token, 'ping')).status, 'connexion coupée après le rejeu').toBe(401);

  return `401 + métadonnées, client ${client.slice(0, 12)}…, consentement, PKCE, 3 outils, hub.mon_compte sur le bon compte, apps : ${preuves.join(', ') || 'aucune'}, rejeu coupé`;
}, { timeout: 300_000 });
