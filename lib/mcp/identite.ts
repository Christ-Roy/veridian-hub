/**
 * Identité que le Hub présente aux MCP des apps : un JWT ES256 de 5 min, `aud` = l'URL MCP de
 * l'app, `sub` = hub_user_id. Les apps le vérifient par la clé publique (/.well-known/jwks.json) :
 * aucun secret partagé, aucune configuration au Hub par app (docs/CONTRAT-MCP.md).
 */
import { randomUUID } from 'node:crypto';

import { SignJWT, importJWK, type JWK } from 'jose';

import { DOWNSTREAM_TTL_S, hubIssuer } from './config';

type Cle = { privee: CryptoKey | Uint8Array; publique: JWK; kid: string };
let cache: { brut: string; cle: Cle } | null = null;

/**
 * Clé de signature, depuis MCP_SIGNING_JWK : JWK privée EC P-256 avec `kid`, en JSON ou en base64
 * (forme rendue par le job : le fichier d'environnement de Nomad n'accepte pas de guillemets nus).
 * Null si absente.
 */
export async function cleSignature(env: NodeJS.ProcessEnv = process.env): Promise<Cle | null> {
  const brut = env.MCP_SIGNING_JWK;
  if (!brut) return null;
  if (cache?.brut === brut) return cache.cle;
  const texte = brut.trim().startsWith('{') ? brut : Buffer.from(brut, 'base64').toString('utf8');
  const jwk = JSON.parse(texte) as JWK;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.kid) throw new Error('MCP_SIGNING_JWK : JWK EC P-256 privée avec kid attendue');
  const privee = await importJWK(jwk, 'ES256');
  const { d: _d, ...publique } = jwk;
  const cle = { privee, publique: { ...publique, alg: 'ES256', use: 'sig' }, kid: jwk.kid };
  cache = { brut, cle };
  return cle;
}

export async function jwksPublic(env: NodeJS.ProcessEnv = process.env): Promise<{ keys: JWK[] }> {
  const cle = await cleSignature(env);
  return { keys: cle ? [cle.publique] : [] };
}

export async function signerPourApp(
  c: { audience: string; hubUserId: string; email: string; clientId: string; scope: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const cle = await cleSignature(env);
  if (!cle) throw new Error('MCP_SIGNING_JWK absente : la porte ne peut pas présenter l\'identité aux apps');
  return new SignJWT({ email: c.email, email_verified: true, scope: c.scope, client_id: c.clientId })
    .setProtectedHeader({ alg: 'ES256', kid: cle.kid, typ: 'JWT' })
    .setIssuer(hubIssuer(env))
    .setAudience(c.audience)
    .setSubject(c.hubUserId)
    .setIssuedAt()
    .setExpirationTime(`${DOWNSTREAM_TTL_S}s`)
    .setJti(randomUUID())
    .sign(cle.privee);
}
