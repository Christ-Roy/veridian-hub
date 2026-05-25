/**
 * Constantes partagées par les routes OAuth Mail Sender (Hub).
 *
 * Extrait de `app/api/gmail/connect/route.ts` pour pouvoir être ré-importé
 * par `app/api/gmail/connect/callback/route.ts` — Next.js interdit les
 * exports custom (`export const _internals = ...`) dans les fichiers
 * `route.ts`, ils doivent vivre dans un module séparé.
 */

export const STATE_COOKIE = 'mail-oauth-state';
export const RETURN_COOKIE = 'mail-oauth-return';
/** TTL du cookie state CSRF (10 minutes). */
export const STATE_TTL_SECONDS = 10 * 60;

/**
 * Source de vérité de l'origin Hub pour les redirects OAuth.
 *
 * IMPORTANT : derrière Traefik / reverse proxy, Next.js bind sur
 * `0.0.0.0:3000` et `new URL(request.url)` produit
 * `https://0.0.0.0:3000/...` qui :
 *  1. Casse les redirect_uri envoyés à Google → `invalid_request`
 *  2. Casse les `NextResponse.redirect(new URL(path, request.url))` →
 *     le browser charge `https://0.0.0.0:3000/...` → ERR_ADDRESS_INVALID
 *
 * Toujours utiliser ce helper pour construire l'URL de base côté Hub.
 * Fallback sur l'argument `requestUrl` pour compat local-dev sans
 * `NEXT_PUBLIC_SITE_URL` (l'origin reçu en local-dev = localhost:3000
 * qui est valide).
 */
export function getHubBaseUrl(requestUrl: string | URL): URL {
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL &&
    process.env.NEXT_PUBLIC_SITE_URL.trim() !== ''
      ? process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, '')
      : null;
  if (siteUrl) {
    return new URL(siteUrl);
  }
  // Fallback : l'origin de la requête (local-dev cas)
  return new URL(
    typeof requestUrl === 'string' ? requestUrl : requestUrl.toString(),
  );
}

/**
 * Construit la redirect URI exacte attendue par Google OAuth Client 2.
 * Doit matcher les URIs déclarées en Console (prod / staging / localhost).
 *
 * IMPORTANT : ne PAS dériver du `origin` de la requête HTTP (`url.host`)
 * car derrière Traefik / un reverse proxy, Next.js bind sur `0.0.0.0:3000`
 * et le `Host` reçu peut être `0.0.0.0:3000` (= Google rejette
 * "invalid_request: redirect_uri 0.0.0.0:3000 not in the list").
 *
 * Source de vérité = `NEXT_PUBLIC_SITE_URL` (env propre injectée par le
 * compose, vaut `https://hub.staging.veridian.site` en staging et
 * `https://app.veridian.site` en prod). Argument `origin` conservé pour
 * compat (utilisé en local-dev sans cette ENV : fallback sur l'origin reçu).
 */
export function buildRedirectUri(origin: string): string {
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL &&
    process.env.NEXT_PUBLIC_SITE_URL.trim() !== ''
      ? process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, '')
      : origin;
  return `${siteUrl}/api/gmail/connect/callback`;
}
