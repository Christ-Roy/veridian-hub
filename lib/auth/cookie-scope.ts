/**
 * Helpers cookies — nom + scope pour le sessionToken Auth.js et le hint
 * cookie cross-subdomain (`veridian-session-hint`).
 *
 * **Pivot 2026-05-27** : on N'OVERRIDE PLUS le cookie session principal
 * Auth.js. Il garde le scope par défaut (host courant = app.veridian.site
 * en prod). Sinon, déployer la version `.veridian.site` invaliderait
 * toutes les sessions actives prod. Décision Robert : zéro downtime
 * sessions.
 *
 * Le partage de session avec la landing CF Pages (veridian.site) passe
 * désormais par un **cookie hint séparé** :
 *   - cookie session principal `__Secure-authjs.session-token` →
 *     httpOnly, scope app.veridian.site (défaut) — comme avant
 *   - cookie hint `veridian-session-hint` → JS-readable, scope
 *     `.veridian.site`, signé JWT HS256, contient `{email, name, image}`
 *     uniquement. Pas de claims sensibles, pas de userId.
 *
 * Ce module expose 3 utilitaires :
 *   - `resolveSessionCookieName(env)` — nom du sessionToken Auth.js,
 *     préfixé `__Secure-` en NODE_ENV=production. Utilisé comme `salt`
 *     dans `encode()` pour que @auth/core puisse déchiffrer le JWT.
 *   - `resolveHintCookieDomain(env)` — `domain` à appliquer au hint
 *     cookie (scope cross-subdomain). Réutilisé par session-hint-cookie.ts.
 *   - `setSessionCookieOnResponse(res, jwt, {maxAge})` — pose le cookie
 *     session principal sur une NextResponse. **PAS de `domain`** —
 *     scope par défaut (host courant). Utilisé par les routes qui forgent
 *     un cookie session (one-tap callback).
 */

import type { NextResponse } from 'next/server';

export type SessionCookieDomainEnv = {
  DEPLOY_ENV?: string;
  NODE_ENV?: string;
  // Index signature pour rester assignable depuis process.env.
  [key: string]: string | undefined;
};

/**
 * Nom du cookie session Auth.js — préfixe `__Secure-` requis dès que le
 * cookie porte le flag `secure` (= NODE_ENV=production, build prod HTTPS).
 *
 * Convention `authjs.session-token` (Auth.js v5) — l'ancien
 * `next-auth.session-token` est rétro-compat mais déprécié.
 *
 * Utilisé comme `salt` dans `encode()` de `next-auth/jwt` — DOIT matcher
 * exactement le nom du cookie réel sinon @auth/core ne peut pas déchiffrer
 * le JWT au prochain `auth()`.
 */
export function resolveSessionCookieName(env: SessionCookieDomainEnv = process.env): string {
  return env.NODE_ENV === 'production'
    ? '__Secure-authjs.session-token'
    : 'authjs.session-token';
}

/**
 * Résout le `domain` du cookie hint cross-subdomain selon DEPLOY_ENV.
 *
 * - `prod`    → `.veridian.site`         (apex + tous sous-domaines)
 * - `staging` → `.staging.veridian.site` (hub.staging + futur landing staging)
 * - dev/test  → `undefined`              (host courant, typ. localhost)
 *
 * NB : ce scope ne s'applique JAMAIS au cookie session principal. Voir
 * le commentaire du module pour le pourquoi.
 */
export function resolveHintCookieDomain(
  env: SessionCookieDomainEnv = process.env,
): string | undefined {
  if (env.DEPLOY_ENV === 'prod') return '.veridian.site';
  if (env.DEPLOY_ENV === 'staging') return '.staging.veridian.site';
  return undefined;
}

/**
 * Pose le cookie session Auth.js sur une NextResponse — utilisé par les
 * routes qui forgent une session manuellement (one-tap callback).
 *
 * **PAS de `domain` explicite** : le cookie est scope host courant
 * (`app.veridian.site` en prod), exactement comme un cookie posé par le
 * flow OAuth standard Auth.js. C'est intentionnel — voir le pivot 2026-05-27
 * en haut du module.
 *
 * `maxAge` est requis (en secondes).
 */
export function setSessionCookieOnResponse(
  response: NextResponse,
  sessionJwt: string,
  options: { maxAge: number; env?: SessionCookieDomainEnv },
): void {
  const env = options.env ?? process.env;
  const cookieName = resolveSessionCookieName(env);
  const isProductionBuild = env.NODE_ENV === 'production';
  response.cookies.set(cookieName, sessionJwt, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isProductionBuild,
    // PAS de `domain` — scope host courant (= `app.veridian.site` en prod,
    // comme tous les autres cookies session Auth.js du Hub). Le partage
    // cross-subdomain est assuré par le hint cookie séparé.
    maxAge: options.maxAge,
  });
}
