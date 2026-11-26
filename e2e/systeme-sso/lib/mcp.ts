/**
 * Porte MCP vue d'un client IA : enregistrement dynamique, consentement dans le navigateur avec la session Hub,
 * échange PKCE, appels JSON-RPC. Le cas 13 garde son propre parcours (il éprouve aussi le flux lui-même) ; les autres
 * cas passent par ici.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Browser } from '@playwright/test';

import { HUB_URL } from './cibles';
import { NonAbouti } from './etat';
import { RUN_DIR } from './versions';

const RETOUR = 'http://127.0.0.1:53682/callback';

let id = 0;
export async function rpc(jeton: string, method: string, params: Record<string, unknown> = {}) {
  const r = await fetch(`${HUB_URL}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${jeton}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
}

/** Appelle un outil de la porte et rend son texte et son drapeau d'erreur. */
export async function outil(jeton: string, name: string, args: Record<string, unknown>) {
  const r = await rpc(jeton, 'tools/call', { name, arguments: args });
  if (!r.json?.result) throw new NonAbouti(`porte MCP : ${name} → HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  return { texte: String(r.json.result.content?.[0]?.text ?? ''), isError: Boolean(r.json.result.isError) };
}

/** `SSO_MCP_CLIENT` réutilise un client déjà enregistré, comme le fait un vrai client IA. Un seul enregistrement par nom et par exécution : le Hub les borne par adresse (429 vu le 25/11), et plusieurs personnes partagent un client. */
/**
 * Clients enregistrés, gardés SUR DISQUE par Hub et par nom (26/11) : en mémoire seulement, chaque redémarrage du processus de travail
 * (après un échec) réenregistrait ; la batterie complète a atteint la limite du Hub et quatre cas sont sortis NON ABOUTIS (429).
 * Un client a 7 jours au plus ; refusé par le Hub, il est oublié et réenregistré (`oublierClient`).
 */
const FICHIER_CLIENTS = join(RUN_DIR, 'mcp-clients.json');
const SEPT_JOURS = 7 * 86_400_000;
type Clients = Record<string, { id: string; le: number }>;
const lireClients = (): Clients => { try { return existsSync(FICHIER_CLIENTS) ? JSON.parse(readFileSync(FICHIER_CLIENTS, 'utf8')) : {}; } catch { return {}; } };
const cleClient = (clientName: string) => `${HUB_URL}|${clientName}`;
const enregistres = {
  get(clientName: string): string | undefined {
    const c = lireClients()[cleClient(clientName)];
    return c && Date.now() - c.le < SEPT_JOURS ? c.id : undefined;
  },
  set(clientName: string, id: string) {
    const tous = lireClients();
    tous[cleClient(clientName)] = { id, le: Date.now() };
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(FICHIER_CLIENTS, JSON.stringify(tous));
  },
};
export function oublierClient(clientName: string) {
  const tous = lireClients();
  delete tous[cleClient(clientName)];
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(FICHIER_CLIENTS, JSON.stringify(tous));
}
async function enregistrer(adresse: string, clientName: string): Promise<string> {
  const demander = () => fetch(adresse, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [RETOUR], token_endpoint_auth_method: 'none' }),
  });
  let reg = await demander();
  // La borne du Hub n'est pas l'objet testé : on attend ce qu'elle annonce, une fois.
  const attente = Number(reg.headers.get('retry-after') ?? 0);
  if (reg.status === 429 && attente > 0 && attente <= 600) {
    await new Promise((ok) => setTimeout(ok, (attente + 2) * 1000));
    reg = await demander();
  }
  if (reg.status !== 201) throw new NonAbouti(`enregistrement MCP refusé : HTTP ${reg.status}${attente ? `, réessai dans ${attente} s` : ''}`);
  const id = (await reg.json()).client_id as string;
  enregistres.set(clientName, id);
  return id;
}

/** Jeton MCP d'un compte : un vrai consentement, comme un client IA le ferait. */
export async function obtenirJetonMcp(browser: Browser, E: { etat: unknown }, clientName = 'TEST SYSTEME SSO'): Promise<string> {
  const prm = await (await fetch(`${HUB_URL}/.well-known/oauth-protected-resource`)).json();
  const as = await (await fetch(`${HUB_URL}/.well-known/oauth-authorization-server`)).json();
  const client = enregistres.get(clientName) ?? process.env.SSO_MCP_CLIENT ?? (await enregistrer(as.registration_endpoint as string, clientName));

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
  let retour = '';
  const ctx = await browser.newContext({ storageState: E.etat as never });
  try {
    const page = await ctx.newPage();
    page.on('response', (r) => {
      const loc = r.headers().location ?? '';
      if (r.url().includes('/oauth/authorize') && r.status() === 303 && loc.startsWith(RETOUR)) retour = loc;
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    // Un client gardé que le Hub ne connaît plus : pas de bouton. On l'oublie pour que le passage suivant le réenregistre.
    if (!(await page.getByRole('button', { name: 'Autoriser' }).isVisible({ timeout: 15_000 }).catch(() => false))) {
      oublierClient(clientName);
      throw new NonAbouti(`consentement MCP sans bouton (client ${client} inconnu du Hub ?) : oublié, réenregistré au prochain passage`);
    }
    await page.getByRole('button', { name: 'Autoriser' }).click();
    await expect.poll(() => retour, { timeout: 20_000 }).not.toBe('');
  } finally {
    await ctx.close();
  }
  const code = new URL(retour).searchParams.get('code');
  if (!code) throw new NonAbouti('consentement MCP sans code');
  const tok = await fetch(`${HUB_URL}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client, redirect_uri: RETOUR, code_verifier: verifier, resource: prm.resource }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (tok.status !== 200) {
    if (tok.status === 400 || tok.status === 401) oublierClient(clientName);
    throw new NonAbouti(`échange MCP refusé : HTTP ${tok.status}`);
  }
  return (await tok.json()).access_token as string;
}
