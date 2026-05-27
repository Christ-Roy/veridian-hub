/**
 * Configuration du cookie session Auth.js — scope cross-subdomain.
 *
 * Permet à la landing CF Pages (veridian.site) et au Hub (app.veridian.site)
 * de partager la même session cookie. Sans `domain` explicite, Auth.js scope
 * le cookie sur l'host exact qui l'a posé — la landing ne verrait jamais le
 * cookie posé par /api/auth/callback côté Hub.
 *
 * Règles de scope par DEPLOY_ENV :
 *   - `prod`     → `.veridian.site`         (partagé entre veridian.site + app.veridian.site)
 *   - `staging`  → `.staging.veridian.site` (partagé entre hub.staging.veridian.site + futur veridian.staging.site)
 *   - autre/dev  → `undefined`              (laisse Auth.js gérer — localhost)
 *
 * Nom du cookie : on garde le défaut Auth.js v5 — `__Secure-authjs.session-token`
 * en prod/staging (NODE_ENV=production → préfixe `__Secure-`), `authjs.session-token`
 * en local-dev. On utilise NODE_ENV ici (pas DEPLOY_ENV) parce que le préfixe
 * `__Secure-` est lié à la présence du flag `secure` du cookie, qui dépend de
 * HTTPS — donc de NODE_ENV=production qui force le build prod Next.js (cf.
 * memory feedback_node_env_vs_deploy_env : on évite NODE_ENV pour distinguer
 * staging/prod, MAIS ici on l'utilise pour distinguer prod-build vs local-dev,
 * ce qui EST son rôle légitime).
 */

import type { NextAuthConfig } from 'next-auth';
import type { NextResponse } from 'next/server';

export type SessionCookieDomainEnv = {
  DEPLOY_ENV?: string;
  NODE_ENV?: string;
  // Index signature pour rester assignable depuis process.env.
  [key: string]: string | undefined;
};

/**
 * Résout le `domain` du cookie session selon DEPLOY_ENV.
 *
 * Retourne `undefined` pour les envs non-production (dev, test, CI sans
 * DEPLOY_ENV posé) — laisse le navigateur scoper sur l'host courant.
 */
export function resolveSessionCookieDomain(
  env: SessionCookieDomainEnv = process.env,
): string | undefined {
  if (env.DEPLOY_ENV === 'prod') return '.veridian.site';
  if (env.DEPLOY_ENV === 'staging') return '.staging.veridian.site';
  return undefined;
}

/**
 * Résout le nom du cookie session — préfixe `__Secure-` requis dès que le
 * cookie porte le flag `secure` (= NODE_ENV=production, build prod HTTPS).
 *
 * On lit la convention `authjs.session-token` (Auth.js v5) — l'ancien nom
 * `next-auth.session-token` est rétro-compat mais déprécié. Auth.js v5 pose
 * le bon nom selon NODE_ENV même sans config — on le redéclare ici parce que
 * dès qu'on override `cookies.sessionToken`, Auth.js attend le `name` complet
 * de notre côté (pas de fallback partiel).
 */
export function resolveSessionCookieName(env: SessionCookieDomainEnv = process.env): string {
  return env.NODE_ENV === 'production'
    ? '__Secure-authjs.session-token'
    : 'authjs.session-token';
}

/**
 * Configuration complète de l'override `cookies` pour `NextAuth()`.
 *
 * Renvoie un partial typé compatible avec `NextAuthConfig['cookies']`. Les
 * autres cookies Auth.js (csrf, pkce, state, nonce) restent au défaut.
 */
export function resolveSessionCookieConfig(
  env: SessionCookieDomainEnv = process.env,
): NextAuthConfig['cookies'] {
  const domain = resolveSessionCookieDomain(env);
  const isProductionBuild = env.NODE_ENV === 'production';
  return {
    sessionToken: {
      name: resolveSessionCookieName(env),
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: isProductionBuild,
        // `domain: undefined` est explicitement ignoré par le sérialiseur de
        // cookie — équivalent à "ne pas poser l'attribut Domain", ce qu'on
        // veut en local-dev.
        domain,
      },
    },
  };
}

/**
 * Pose le cookie session Auth.js sur une NextResponse — utilisé par les
 * routes qui forgent une session manuellement (One Tap callback, impersonate
 * callback). Garantit le même scope cross-subdomain que celui appliqué par
 * Auth.js sur les flows OAuth standard.
 *
 * `maxAge` est requis (en secondes) — la valeur dépend de l'usage (90j pour
 * un login normal, plus court pour une session forgée).
 */
export function setSessionCookieOnResponse(
  response: NextResponse,
  sessionJwt: string,
  options: { maxAge: number; env?: SessionCookieDomainEnv },
): void {
  const env = options.env ?? process.env;
  const cookieName = resolveSessionCookieName(env);
  const domain = resolveSessionCookieDomain(env);
  const isProductionBuild = env.NODE_ENV === 'production';
  response.cookies.set(cookieName, sessionJwt, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isProductionBuild,
    domain,
    maxAge: options.maxAge,
  });
}
