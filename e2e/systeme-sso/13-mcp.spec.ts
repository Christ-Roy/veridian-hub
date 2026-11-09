/**
 * Porte MCP (docs/CONTRAT-MCP.md) : le parcours d'un vrai client IA sur ce qui est servi.
 * Découverte (401 + métadonnées), enregistrement dynamique, consentement dans le navigateur avec la
 * session Hub, échange PKCE, initialize, trois outils, recherche puis exécution de hub.mon_compte sur
 * le bon compte, rotation (le renouvellement rejoué coupe la connexion). Épreuve : `SSO_SABOTAGE=mcp`
 * (mauvais vérificateur PKCE : l'échange doit échouer).
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect } from '@playwright/test';

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerAnalyticsAuHub, activerTwentyAuHub, admin, rybbitCompte } from './lib/hub-admin';
import { assurerRybbit } from './lib/monde';
import { creerCompteProuve, noterEspaceTwenty } from './lib/parcours';

const RETOUR = 'http://127.0.0.1:53682/callback';

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
  const registre = ((await admin<{ apps: { appKey: string; enabled: boolean }[] }>('GET', 'mcp-apps')).json?.apps ?? [])
    .filter((a) => a.enabled)
    .map((a) => a.appKey)
    .sort();
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
  // lecture seule sans paramètre obligatoire s'exécute sur ce compte. Rien de propre à une app ici.
  const appsOuvertes = (trouve.apps as string[]).filter((a) => a !== 'hub');
  type Ligne = { app: string; statut: 'ok' | 'echec' | 'sans_outil_lecture'; outil: string; extrait: string };
  const tableau: Ligne[] = (trouve.injoignables ?? []).map((i: { app: string; raison: string }) => ({ app: i.app, statut: 'echec' as const, outil: '-', extrait: i.raison }));
  for (const app of appsOuvertes) {
    if (tableau.some((l) => l.app === app)) continue;
    const liste = JSON.parse((await rpc(t.access_token, 'tools/call', { name: 'chercher_outils', arguments: { besoin: '', app } })).json.result.content[0].text);
    if (!liste.outils?.length) {
      tableau.push({ app, statut: 'echec', outil: '-', extrait: 'aucun outil rendu' });
      continue;
    }
    let ligne: Ligne = { app, statut: 'sans_outil_lecture', outil: '-', extrait: `${liste.outils.length} outils, aucun en lecture seule sans paramètre` };
    for (const o of liste.outils as { nom: string }[]) {
      const d = JSON.parse((await rpc(t.access_token, 'tools/call', { name: 'decrire_outil', arguments: { nom: o.nom } })).json.result.content[0].text);
      if (d.annotations?.readOnlyHint !== true || ((d.parametres?.required ?? []) as string[]).length > 0) continue;
      const r = (await rpc(t.access_token, 'tools/call', { name: 'executer_outil', arguments: { nom: o.nom, arguments: {} } })).json.result;
      const texte = String(r.content?.[0]?.text ?? '').replace(/\s+/g, ' ');
      ligne = { app, statut: r.isError ? 'echec' : 'ok', outil: o.nom, extrait: texte.slice(0, 140) };
      break;
    }
    tableau.push(ligne);
  }
  // Tableau complet, lisible même en échec (le rapport de la batterie tronque le détail).
  writeFileSync(path.join(__dirname, '.run', 'mcp-federation.json'), JSON.stringify(tableau, null, 2));
  expect(tableau.map((l) => l.app).sort(), 'chaque app du registre passe par la porte').toEqual(registre);
  const preuves = tableau.map((l) => `${l.app}=${l.statut}${l.outil !== '-' ? `(${l.outil})` : ''}`);
  expect(tableau.filter((l) => l.statut === 'echec'), `apps en échec par la porte : ${JSON.stringify(tableau)}`).toEqual([]);

  // Rotation : le nouveau marche, l'ancien rejoué coupe toute la connexion.
  const t2 = await (await form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client })).json();
  expect((await rpc(t2.access_token, 'ping')).status).toBe(200);
  expect((await form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client })).status).toBe(400);
  expect((await rpc(t2.access_token, 'ping')).status, 'connexion coupée après le rejeu').toBe(401);

  return `401 + métadonnées, client ${client.slice(0, 12)}…, consentement, PKCE, 3 outils, hub.mon_compte sur le bon compte, apps : ${preuves.join(', ') || 'aucune'}, rejeu coupé`;
}, { timeout: 300_000 });
