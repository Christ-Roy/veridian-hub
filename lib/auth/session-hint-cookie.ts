/**
 * Cookie hint cross-subdomain `veridian-session-hint`.
 *
 * **Pourquoi** : la landing CF Pages (veridian.site) doit pouvoir détecter
 * qu'un user a déjà une session sur app.veridian.site, SANS toucher au
 * cookie session principal (qui doit rester scope app.veridian.site pour
 * ne pas invalider les sessions actives au déploiement).
 *
 * Solution : un second cookie, **lisible côté JS** (`HttpOnly: false`),
 * scope `.veridian.site` (cross-subdomain), contenant un JWT signé HS256
 * avec un payload léger : `{email, name?, image?}`. La landing parse le
 * cookie, vérifie la signature côté serveur (via fetch /api/me/lite qui
 * fait la même chose côté Hub) ou se contente d'afficher l'email.
 *
 * Sécurité — pourquoi un JWT signé même pour des claims "publics" :
 *   1. Empêche un utilisateur malveillant d'éditer le cookie pour faire
 *      croire à la landing "je suis admin@veridian.site". Le JWT signé
 *      garantit que le contenu vient bien du Hub.
 *   2. Permet d'expirer le hint indépendamment du cookie session (ex :
 *      hint expire à 30j, session à 90j → si le hint est périmé, la
 *      landing tombe en flow "logged-out" alors que la session existe
 *      encore — la prochaine visite app.veridian.site refresh le hint).
 *   3. Pas d'info sensible → vol du hint cookie = pas de takeover. Le
 *      cookie session reste httpOnly, inaccessible JS, exempt d'XSS.
 *
 * Secret de signature : `SESSION_HINT_SECRET` (HS256, ≥ 32 chars). Distinct
 * de `AUTH_SECRET` (rotation indépendante, blast radius isolé).
 */

import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { resolveHintCookieDomain, type SessionCookieDomainEnv } from '@/lib/auth/cookie-scope';

/** Nom du cookie hint — partagé entre Hub et future landing. */
export const SESSION_HINT_COOKIE_NAME = 'veridian-session-hint';

/** TTL du hint : 30 jours. */
export const SESSION_HINT_TTL_S = 60 * 60 * 24 * 30;

/** Algorithme JWT signé (symétrique, simple, rapide). */
const SESSION_HINT_ALG = 'HS256';

/** Issuer figé pour audit + défense en profondeur côté décodage. */
const SESSION_HINT_ISSUER = 'veridian-hub';

/** Claims légers exposés à la landing. Pas de userId, pas de role. */
export type SessionHintClaims = {
  email: string;
  name?: string | null;
  image?: string | null;
};

/**
 * Récupère le secret HS256 depuis l'env. Throw si absent ou trop court —
 * un secret faible casse la garantie d'intégrité du hint.
 */
function getSessionHintSecret(env: SessionCookieDomainEnv = process.env): Uint8Array {
  const raw = env.SESSION_HINT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      'SESSION_HINT_SECRET manquant ou < 32 chars — refus de signer/vérifier un hint cookie',
    );
  }
  return new TextEncoder().encode(raw);
}

/**
 * Forge un JWT HS256 contenant les claims hint + exp 30j.
 *
 * Exporté pour permettre aux tests d'injecter un secret custom et de
 * vérifier le contenu sans passer par le helper de set cookie.
 */
export async function encodeSessionHintJwt(
  claims: SessionHintClaims,
  env: SessionCookieDomainEnv = process.env,
): Promise<string> {
  const secret = getSessionHintSecret(env);
  return new SignJWT({
    email: claims.email,
    name: claims.name ?? null,
    image: claims.image ?? null,
  })
    .setProtectedHeader({ alg: SESSION_HINT_ALG })
    .setIssuer(SESSION_HINT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_HINT_TTL_S)
    .sign(secret);
}

/**
 * Décode + vérifie un JWT hint. Renvoie les claims si valide, `null` sinon.
 *
 * Catch tout (signature invalide, exp dépassé, issuer mismatch, JSON
 * malformé) — la lecture du hint ne doit JAMAIS throw. C'est juste un
 * indice UX, pas une autorité de session.
 */
export async function decodeSessionHintJwt(
  token: string,
  env: SessionCookieDomainEnv = process.env,
): Promise<SessionHintClaims | null> {
  try {
    const secret = getSessionHintSecret(env);
    const { payload } = await jwtVerify(token, secret, {
      issuer: SESSION_HINT_ISSUER,
      algorithms: [SESSION_HINT_ALG],
    });
    if (typeof payload.email !== 'string' || payload.email.length === 0) {
      return null;
    }
    return {
      email: payload.email,
      name: typeof payload.name === 'string' ? payload.name : null,
      image: typeof payload.image === 'string' ? payload.image : null,
    };
  } catch (err) {
    // exp dépassé, signature, issuer, etc. — silencieux.
    if (
      err instanceof joseErrors.JOSEError ||
      err instanceof Error
    ) {
      return null;
    }
    return null;
  }
}

/**
 * Pose le cookie hint sur une NextResponse. Lisible par le JS de la landing
 * (`HttpOnly: false`) pour qu'elle puisse l'afficher sans round-trip API.
 *
 * Scope `.veridian.site` (prod) / `.staging.veridian.site` (staging) /
 * host-default (dev), via `resolveHintCookieDomain`.
 */
export async function setSessionHintCookie(
  response: NextResponse,
  claims: SessionHintClaims,
  env: SessionCookieDomainEnv = process.env,
): Promise<void> {
  const jwt = await encodeSessionHintJwt(claims, env);
  const domain = resolveHintCookieDomain(env);
  const isProductionBuild = env.NODE_ENV === 'production';
  response.cookies.set(SESSION_HINT_COOKIE_NAME, jwt, {
    httpOnly: false, // VOLONTAIRE : la landing doit le lire en JS
    sameSite: 'lax',
    path: '/',
    secure: isProductionBuild,
    domain,
    maxAge: SESSION_HINT_TTL_S,
  });
}

/**
 * Supprime le cookie hint (set valeur vide + Max-Age 0). À appeler au
 * signOut.
 */
export function clearSessionHintCookie(
  response: NextResponse,
  env: SessionCookieDomainEnv = process.env,
): void {
  const domain = resolveHintCookieDomain(env);
  const isProductionBuild = env.NODE_ENV === 'production';
  response.cookies.set(SESSION_HINT_COOKIE_NAME, '', {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    secure: isProductionBuild,
    domain,
    maxAge: 0,
  });
}

/**
 * Même suppression que `clearSessionHintCookie`, mais rendue sous forme de
 * valeur `Set-Cookie` brute.
 *
 * Sert aux endroits où l'on n'a PAS la main sur la construction de la
 * réponse et où l'on doit greffer le header sur une `Response` déjà forgée
 * par une lib tierce — typiquement la réponse du signOut Auth.js (cf.
 * `app/api/auth/[...nextauth]/route.ts`).
 *
 * Passe par une NextResponse jetable plutôt que par une sérialisation
 * maison : le format du cookie reste garanti identique à celui posé par
 * `clearSessionHintCookie` (mêmes domaine, path, flags), donc le navigateur
 * matche bien le cookie à supprimer.
 */
export function buildClearedSessionHintSetCookie(
  env: SessionCookieDomainEnv = process.env,
): string {
  const holder = new NextResponse(null);
  clearSessionHintCookie(holder, env);
  const [cookie] = holder.headers.getSetCookie();
  if (!cookie) {
    throw new Error('Impossible de sérialiser le Set-Cookie de suppression du hint');
  }
  return cookie;
}

/**
 * Lit + valide le cookie hint depuis une requête. Renvoie les claims si
 * cookie présent + JWT valide + non expiré, `null` sinon.
 *
 * Utilisé par `/api/me/lite` pour répondre rapidement sans appeler
 * `auth()` (qui valide la session principale via cookie httpOnly + JWE
 * @auth/core — beaucoup plus coûteux).
 */
export async function readSessionHintFromRequest(
  request: Pick<NextRequest, 'cookies'>,
  env: SessionCookieDomainEnv = process.env,
): Promise<SessionHintClaims | null> {
  const cookie = request.cookies.get(SESSION_HINT_COOKIE_NAME);
  if (!cookie?.value) return null;
  return decodeSessionHintJwt(cookie.value, env);
}
