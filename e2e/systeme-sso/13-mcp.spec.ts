/**
 * Porte MCP (docs/CONTRAT-MCP.md) : le parcours d'un vrai client IA sur ce qui est servi.
 * Découverte (401 + métadonnées), enregistrement dynamique, consentement dans le navigateur avec la
 * session Hub, échange PKCE, initialize, trois outils, recherche puis exécution de hub.mon_compte sur
 * le bon compte, rotation (le renouvellement rejoué coupe la connexion). Épreuve : `SSO_SABOTAGE=mcp`
 * (mauvais vérificateur PKCE : l'échange doit échouer).
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { creerCompteProuve } from './lib/parcours';

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
    await page.route(`${RETOUR}**`, (r) => {
      retour = r.request().url();
      return r.fulfill({ status: 200, body: 'ok' });
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByText('TEST SYSTEME SSO', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Autoriser' }).click();
    await expect.poll(() => retour, { timeout: 20_000 }).not.toBe('');
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

  // Rotation : le nouveau marche, l'ancien rejoué coupe toute la connexion.
  const t2 = await (await form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client })).json();
  expect((await rpc(t2.access_token, 'ping')).status).toBe(200);
  expect((await form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client })).status).toBe(400);
  expect((await rpc(t2.access_token, 'ping')).status, 'connexion coupée après le rejeu').toBe(401);

  return `401 + métadonnées, client ${client.slice(0, 12)}…, consentement de ${E.email}, PKCE, 3 outils, hub.mon_compte sur le bon compte, rejeu coupé`;
}, { timeout: 300_000 });
