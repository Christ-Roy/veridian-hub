/**
 * Les portes du CRM qu'une personne tient hors de son cookie (25/11 : on a dit « fermé » sur le seul cookie) : jeton d'accès (GraphQL, REST, identité,
 * MCP), rafraîchissement, flux en direct, lien de connexion non consommé. Rien n'est affiché : les jetons restent en mémoire.
 */
import { randomUUID } from 'node:crypto';

import { NonAbouti } from './etat';
import { appelTwenty } from './hub-admin';
import type { Compte } from './parcours';

export const COMPAGNIES = '{companies(first:1){edges{node{id}}}}';
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
type Json = any;

/** Jeton d'accès et de rafraîchissement du CRM, tels que son écran les obtient du lien ; gardés en mémoire, jamais affichés. */
export async function lienCrm(crm: string, c: Compte): Promise<string> {
  const lien = (await (await appelTwenty('POST', '/api/sso/issue-magic-link', { hub_user_id: c.hubUserId, email: c.email, email_proven: true, next: `${crm}/` })).json().catch(() => null)) as { magic_link_url?: string } | null;
  const rebond = lien?.magic_link_url ? await fetch(lien.magic_link_url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) }) : null;
  return new URL(rebond?.headers.get('location') ?? 'https://absent.invalid/').searchParams.get('loginToken') ?? '';
}
export async function metadata(crm: string, query: string, variables: object, jeton?: string): Promise<Json> {
  const r = await fetch(`${crm}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: crm, ...(jeton ? { authorization: `Bearer ${jeton}` } : {}) }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000) });
  return r.json().catch(() => null);
}
export async function consommer(crm: string, loginToken: string): Promise<{ acces: string | null; long: string | null }> {
  const t = (await metadata(crm, 'mutation($l:String!,$o:String!){getAuthTokensFromLoginToken(loginToken:$l,origin:$o){tokens{accessOrWorkspaceAgnosticToken{token} refreshToken{token}}}}', { l: loginToken, o: crm }))?.data?.getAuthTokensFromLoginToken?.tokens;
  return { acces: t?.accessOrWorkspaceAgnosticToken?.token ?? null, long: t?.refreshToken?.token ?? null };
}
export const graphql = async (crm: string, jeton: string | null, query: string, variables: object = {}): Promise<Json> =>
  (await fetch(`${crm}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000) })).json().catch(() => null);

/** Flux en direct : rend ce qui y arrive, chaque ligne avec son heure, jusqu'à `fermer`. */
export async function ecouter(url: string, init: RequestInit): Promise<{ lignes: { t: number; texte: string }[]; fermer: () => void; statut: number; ouvert: () => boolean }> {
  const arret = new AbortController();
  const r = await fetch(url, { ...init, signal: arret.signal });
  const lignes: { t: number; texte: string }[] = [];
  let ouvert = r.status === 200 && r.body !== null;
  if (ouvert) void (async () => {
    const dec = new TextDecoder();
    let reste = '';
    try {
      for await (const m of r.body as unknown as AsyncIterable<Uint8Array>) {
        const morceaux = (reste + dec.decode(m, { stream: true })).split('\n');
        reste = morceaux.pop() ?? '';
        for (const l of morceaux) if (l.trim()) lignes.push({ t: Date.now(), texte: l });
      }
    } catch { /* fermé */ }
    ouvert = false;
  })();
  return { lignes, fermer: () => arret.abort(), statut: r.status, ouvert: () => ouvert };
}
export async function fluxCrm(crm: string, jeton: string) {
  const id = randomUUID();
  const f = await ecouter(`${crm}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: crm, authorization: `Bearer ${jeton}`, accept: 'text/event-stream' }, body: JSON.stringify({ query: 'subscription($i:String!){onEventSubscription(eventStreamId:$i){objectRecordEventsWithQueryIds{objectRecordEvent{action recordId}}}}', variables: { i: id } }) });
  for (let i = 0; i < 20; i++) {
    await pause(1_000);
    const r = await metadata(crm, 'mutation($i:AddQuerySubscriptionInput!){addQueryToEventStream(input:$i)}', { i: { eventStreamId: id, queryId: 'q', operationSignature: { objectNameSingular: 'company', variables: {} } } }, jeton).catch(() => null);
    if (r?.data?.addQueryToEventStream) return f;
  }
  throw new NonAbouti('le flux en direct du CRM ne s\'ouvre pas');
}

export type Porteur = { acces: string; long: string };
/** Chaque porte : lire UNE donnée de l'espace par elle, et tous les combien. Le rafraîchissement suit sa rotation. */
export const portesCrm = (crm: string): Record<string, { tous: number; lit: (s: Porteur) => Promise<boolean> }> => {
  const entetes = (s: Porteur) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.acces}` });
  return {
    crm_jeton: { tous: 700, lit: async (s) => Array.isArray((await graphql(crm, s.acces, COMPAGNIES))?.data?.companies?.edges) },
    crm_rest: { tous: 700, lit: async (s) => (await fetch(`${crm}/rest/companies?limit=1`, { headers: entetes(s), signal: AbortSignal.timeout(15_000) })).status === 200 },
    crm_identite: { tous: 2_000, lit: async (s) => Boolean((await metadata(crm, '{currentUser{id currentUserWorkspace{id}}}', {}, s.acces))?.data?.currentUser?.id) },
    crm_mcp: { tous: 2_000, lit: async (s) => { const x = await fetch(`${crm}/mcp`, { method: 'POST', headers: { ...entetes(s), accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), signal: AbortSignal.timeout(15_000) }); return x.status === 200 && /"tools":\[\{/.test(await x.text()); } },
    crm_rafraichir: { tous: 8_000, lit: async (s) => { const n = (await metadata(crm, 'mutation($t:String!){renewToken(appToken:$t){tokens{accessOrWorkspaceAgnosticToken{token} refreshToken{token}}}}', { t: s.long }))?.data?.renewToken?.tokens; if (n?.refreshToken?.token) s.long = n.refreshToken.token as string; return Boolean(n?.refreshToken?.token); } },
  };
};
