/**
 * CORS helper pour les routes Hub appelables cross-subdomain depuis la landing.
 *
 * Architecture cible :
 *   - Landing Cloudflare Pages statique sur https://veridian.site (apex)
 *   - Hub Next.js sur https://app.veridian.site
 *   - La landing fait des `fetch()` (Google One Tap callback, /api/me/lite)
 *     vers le Hub. Sans CORS explicite, le navigateur bloque la réponse
 *     (même domain root, mais subdomain différent = origin différent).
 *
 * Whitelist d'origins — strict, pas de regex laxiste. Une origin doit matcher
 * **exactement** la chaîne whitelistée (scheme + host + port implicite). On
 * compose la whitelist depuis :
 *   - ENV `LANDING_ORIGIN` (prod : https://veridian.site)
 *   - ENV `LANDING_ORIGIN_STAGING` (staging future)
 *   - défauts hardcodés couvrant www + apex en prod
 *
 * ⚠️ NE PAS appliquer ce helper à toutes les routes Hub. Réservé aux routes
 * explicitement "cross-subdomain safe" (lecture session lite, callback OAuth
 * popup). Les routes admin/sensibles restent isolées sur app.veridian.site.
 */

import type { NextRequest } from 'next/server';

/**
 * Origins par défaut acceptés. ENV peuvent ajouter / surcharger.
 *
 * Ces valeurs sont **whitelistées** : si l'ENV `LANDING_ORIGIN` est posée,
 * elle est ajoutée à la liste — elle ne remplace pas les défauts.
 */
const DEFAULT_LANDING_ORIGINS = [
  'https://veridian.site',
  'https://www.veridian.site',
] as const;

export type LandingCorsEnv = {
  LANDING_ORIGIN?: string;
  LANDING_ORIGIN_STAGING?: string;
  DEPLOY_ENV?: string;
  // Index signature pour rester assignable depuis process.env (ProcessEnv),
  // qui est un Record<string, string|undefined>.
  [key: string]: string | undefined;
};

/**
 * Calcule la liste complète des origins acceptés selon l'env runtime.
 *
 * - Prod (`DEPLOY_ENV=prod`) : défauts + LANDING_ORIGIN si posé.
 * - Staging (`DEPLOY_ENV=staging`) : LANDING_ORIGIN_STAGING + défauts (au cas
 *   où on teste depuis veridian.site contre le Hub staging).
 * - Local-dev : défauts + LANDING_ORIGIN si posé, plus localhost classique
 *   pour permettre un dev cross-port de la landing.
 *
 * Les chaînes vides ou invalides sont filtrées. Le retour est dédupliqué.
 */
export function getAllowedLandingOrigins(env: LandingCorsEnv = process.env): string[] {
  const origins = new Set<string>(DEFAULT_LANDING_ORIGINS);

  if (env.LANDING_ORIGIN && isValidOrigin(env.LANDING_ORIGIN)) {
    origins.add(env.LANDING_ORIGIN);
  }

  if (env.DEPLOY_ENV === 'staging' && env.LANDING_ORIGIN_STAGING) {
    if (isValidOrigin(env.LANDING_ORIGIN_STAGING)) {
      origins.add(env.LANDING_ORIGIN_STAGING);
    }
  }

  // Local-dev : facilite le dev cross-port de la landing sans config env.
  if (!env.DEPLOY_ENV) {
    origins.add('http://localhost:3000');
    origins.add('http://localhost:4321');
    origins.add('http://localhost:5173');
  }

  return Array.from(origins);
}

/**
 * Vérifie si l'origin de la requête est whitelistée et retourne l'origin
 * exact à renvoyer dans `Access-Control-Allow-Origin`.
 *
 * Retour :
 *   - L'origin string (= echo de la requête) si whitelisté
 *   - `null` sinon → l'appelant NE doit PAS poser de header Allow-Origin
 *     (= rejet implicite par le navigateur)
 *
 * On echo l'origin exact (pas `*`) parce qu'on autorise `credentials: include`
 * (cookie session cross-subdomain) — la spec CORS interdit `*` avec
 * credentials, on doit renvoyer l'origin précis.
 */
export function getAllowedLandingOrigin(
  request: Pick<NextRequest, 'headers'>,
  env: LandingCorsEnv = process.env,
): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;

  const allowed = getAllowedLandingOrigins(env);
  return allowed.includes(origin) ? origin : null;
}

/**
 * Construit les headers CORS à attacher à une Response pour autoriser le
 * cross-subdomain `credentials: include` depuis la landing.
 *
 * Retourne un objet headers (à merger). Si l'origin n'est pas whitelisté,
 * **aucun header CORS n'est posé** — le navigateur côté landing rejettera
 * la réponse (comportement attendu).
 *
 * `Vary: Origin` est ajouté systématiquement (même quand origin absent ou
 * rejeté) pour que les caches intermédiaires (CDN, navigateur) ne mélangent
 * pas la réponse cross-origin avec la réponse same-origin.
 */
export function buildLandingCorsHeaders(
  request: Pick<NextRequest, 'headers'>,
  options: { methods?: string[]; headers?: string[] } = {},
  env: LandingCorsEnv = process.env,
): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  const allowedOrigin = getAllowedLandingOrigin(request, env);
  if (!allowedOrigin) return headers;

  headers['Access-Control-Allow-Origin'] = allowedOrigin;
  headers['Access-Control-Allow-Credentials'] = 'true';
  headers['Access-Control-Allow-Methods'] = (options.methods ?? ['GET', 'POST', 'OPTIONS']).join(
    ', ',
  );
  headers['Access-Control-Allow-Headers'] = (
    options.headers ?? ['Content-Type', 'Authorization']
  ).join(', ');
  // 1h cache du preflight — pas trop long pour pouvoir mettre à jour la
  // whitelist sans attendre des jours côté navigateurs.
  headers['Access-Control-Max-Age'] = '3600';
  return headers;
}

/**
 * Helper preflight OPTIONS — répond 204 + headers CORS.
 *
 * Retourne 204 même si origin non whitelisté (réponse OPTIONS valide HTTP
 * mais sans les headers Allow-Origin → le navigateur bloque la vraie requête).
 */
export function landingCorsPreflightResponse(
  request: Pick<NextRequest, 'headers'>,
  options: { methods?: string[]; headers?: string[] } = {},
  env: LandingCorsEnv = process.env,
): Response {
  const headers = buildLandingCorsHeaders(request, options, env);
  return new Response(null, { status: 204, headers });
}

/**
 * Validation basique d'une string origin : doit commencer par https:// ou
 * http://, pas finir par `/`, pas contenir de wildcard. Filtre les valeurs
 * ENV mal configurées sans crasher.
 */
function isValidOrigin(value: string): boolean {
  if (!value) return false;
  if (value.endsWith('/')) return false;
  if (value.includes('*')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
