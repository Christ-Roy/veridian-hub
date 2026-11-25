/**
 * OAuth vers un service extérieur (VER-119) : découverte (RFC 9728, RFC 8414), enregistrement automatique du client (RFC 7591), code avec PKCE et
 * `state`, jeton demandé pour CE serveur (`resource`, RFC 8707), renouvellement, révocation. Protocole : `openid-client`. Sortie : `fetchGarde`.
 */
import * as oidc from 'openid-client';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { fetchGarde } from '@/lib/federation/sortie';
import { chiffrer, dechiffrer } from '@/lib/ia/coffre';

import { connecteur, type Connecteur } from './registre';

export const COOKIE_CONNECTEUR = 'veridian-connecteur';
export const CHEMIN_RETOUR_CONNECTEUR = '/api/connecteurs/retour';
export const TRANSACTION_CONNECTEUR_S = 10 * 60;

type Db = Pick<PrismaClient, 'connecteurClient'>;
export type Deps = { fetchImpl?: typeof fetchGarde; /** Épreuve : fournisseur jetable en clair. Jamais en service. */ enClair?: boolean; now?: number };
export type Jetons = { acces: string; refresh: string | null; expireLe: Date | null };

const Transaction = z.object({ t: z.literal('connecteur'), cle: z.string(), userId: z.string(), state: z.string(), verifier: z.string(), exp: z.number() });
export type TransactionConnecteur = z.infer<typeof Transaction>;
export function ouvrirTransaction(scelle: string | undefined, now = Date.now()): TransactionConnecteur | null {
  if (!scelle) return null;
  try {
    const x = Transaction.parse(JSON.parse(dechiffrer(scelle)));
    return x.exp * 1000 > now ? x : null;
  } catch {
    return null;
  }
}

const options = (d: Deps) => ({ algorithm: 'oauth2' as const, timeout: 10, [oidc.customFetch]: (d.fetchImpl ?? fetchGarde) as never, execute: d.enClair ? [oidc.allowInsecureRequests] : [] });
const poser = (c: oidc.Configuration, d: Deps): oidc.Configuration => { c.timeout = 10; c[oidc.customFetch] = (d.fetchImpl ?? fetchGarde) as never; return c; };

/** Le serveur d'autorisation que le service désigne pour cette ressource ; à défaut, son origine. */
async function emetteur(c: Connecteur, d: Deps): Promise<URL> {
  const u = new URL(c.mcpUrl);
  for (const chemin of [`/.well-known/oauth-protected-resource${u.pathname}`, '/.well-known/oauth-protected-resource']) {
    const r = await (d.fetchImpl ?? fetchGarde)(new URL(chemin, u).href, { headers: { accept: 'application/json' } }).catch(() => null);
    const j = r?.ok ? ((await r.json().catch(() => null)) as { resource?: unknown; authorization_servers?: unknown[] } | null) : null;
    const a = j?.authorization_servers?.[0];
    if (typeof a === 'string' && (!d.enClair ? a.startsWith('https://') : true)) return new URL(a);
  }
  return new URL(u.origin);
}

/** Notre client chez ce service, enregistré une fois, puis gardé. */
async function configuration(db: Db, c: Connecteur, retour: string, d: Deps): Promise<oidc.Configuration> {
  const chez = await emetteur(c, d);
  const l = await db.connecteurClient.findUnique({ where: { connecteur_retour: { connecteur: c.cle, retour } } });
  if (l) {
    const secret = l.secretChiffre ? dechiffrer(l.secretChiffre) : undefined;
    return poser(await oidc.discovery(chez, l.clientId, secret, secret ? oidc.ClientSecretPost(secret) : oidc.None(), options(d)), d);
  }
  const decouvert = await oidc.discovery(chez, 'veridian', undefined, oidc.None(), options(d));
  const m = decouvert.serverMetadata();
  if (!m.registration_endpoint) throw new Error('sans_enregistrement');
  const methodes = m.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  const methode = methodes.includes('none') ? 'none' : 'client_secret_post';
  const neuf = poser(
    await oidc.dynamicClientRegistration(
      chez,
      { client_name: 'Veridian', client_uri: 'https://veridian.site', redirect_uris: [retour], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: methode, ...(c.portee ? { scope: c.portee } : {}) },
      methode === 'none' ? oidc.None() : oidc.ClientSecretPost(),
      options(d),
    ),
    d,
  );
  const id = neuf.clientMetadata();
  const secret = typeof id.client_secret === 'string' ? id.client_secret : null;
  await db.connecteurClient.create({ data: { connecteur: c.cle, retour, clientId: id.client_id, secretChiffre: secret ? chiffrer(secret) : null } });
  return neuf;
}

export async function partir(db: Db, c: Connecteur, userId: string, retour: string, d: Deps = {}): Promise<{ url: string; cookie: string }> {
  const conf = await configuration(db, c, retour, d);
  const [state, verifier] = [oidc.randomState(), oidc.randomPKCECodeVerifier()];
  const url = oidc.buildAuthorizationUrl(conf, { redirect_uri: retour, state, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', resource: c.mcpUrl, ...(c.portee ? { scope: c.portee } : {}) });
  if (url.protocol !== 'https:' && !d.enClair) throw new Error('autorisation_en_clair');
  const t: TransactionConnecteur = { t: 'connecteur', cle: c.cle, userId, state, verifier, exp: Math.floor((d.now ?? Date.now()) / 1000) + TRANSACTION_CONNECTEUR_S };
  return { url: url.href, cookie: chiffrer(JSON.stringify(t)) };
}

const lire = (r: oidc.TokenEndpointResponse, now: number): Jetons => ({ acces: r.access_token, refresh: typeof r.refresh_token === 'string' ? r.refresh_token : null, expireLe: typeof r.expires_in === 'number' ? new Date(now + r.expires_in * 1000) : null });

/** Échange le code. Lève si quoi que ce soit ne tient pas : state, code, PKCE, retour. */
export async function terminer(db: Db, t: TransactionConnecteur, url: URL, retour: string, d: Deps = {}): Promise<Jetons> {
  const c = connecteur(t.cle);
  if (!c) throw new Error('connecteur_inconnu');
  const conf = await configuration(db, c, retour, d);
  return lire(await oidc.authorizationCodeGrant(conf, url, { pkceCodeVerifier: t.verifier, expectedState: t.state }, { resource: c.mcpUrl }), d.now ?? Date.now());
}

export async function renouveler(db: Db, c: Connecteur, refresh: string, retour: string, d: Deps = {}): Promise<Jetons> {
  const j = lire(await oidc.refreshTokenGrant(await configuration(db, c, retour, d), refresh, { resource: c.mcpUrl }), d.now ?? Date.now());
  // Un service qui ne tourne pas ses jetons garde le même.
  return { ...j, refresh: j.refresh ?? refresh };
}

/** Au mieux : la connexion est effacée chez nous quoi qu'il arrive. */
export async function revoquer(db: Db, c: Connecteur, jeton: string, retour: string, d: Deps = {}): Promise<boolean> {
  try {
    await oidc.tokenRevocation(await configuration(db, c, retour, d), jeton);
    return true;
  } catch {
    return false;
  }
}
