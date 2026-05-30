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
 * Allowlist des hosts apps Veridian autorisés comme `return` URL absolue
 * après le flow OAuth Mail Sender.
 *
 * POURQUOI : les apps downstream (Notifuse, Prospection…) initient le flow
 * Gmail depuis LEUR domaine et veulent rebondir vers leur propre UI après
 * consent. Comme c'est cross-domain, le `return` est une URL ABSOLUE
 * (`https://notifuse.app.veridian.site/...`), pas un path relatif. On ne
 * peut donc PAS se contenter de `startsWith('/')` (qui rejetterait l'URL
 * légitime), mais on ne doit SURTOUT pas accepter n'importe quel host
 * (open-redirect / phishing). D'où cette allowlist stricte.
 *
 * Sécurité : seul le HOST est comparé (jamais le path), HTTPS obligatoire.
 */
export const ALLOWED_RETURN_HOSTS: readonly string[] = [
  'notifuse.app.veridian.site',
  'prospection.app.veridian.site',
  'analytics.app.veridian.site',
  'cms.veridian.site',
  // Staging équivalents (le flow OAuth Gmail réel ne tourne qu'en prod et
  // local-dev — cf gating Tailscale — mais on autorise le rebond staging
  // pour les tests E2E bout-en-bout cross-app sur le dev server).
  'notifuse.staging.veridian.site',
  'prospection.staging.veridian.site',
  'analytics.staging.veridian.site',
  'cms.staging.veridian.site',
];

/**
 * Valide et normalise une `return` URL fournie par une app downstream.
 *
 * Accepte deux formes :
 *  1. Path relatif interne au Hub (`/dashboard/settings/mail`) — utilisé
 *     quand le Hub initie le flow pour lui-même. Rejette `//host` (protocol
 *     -relative = open-redirect déguisé).
 *  2. URL absolue HTTPS dont le host ∈ {@link ALLOWED_RETURN_HOSTS} — utilisé
 *     par les apps downstream pour rebondir cross-domain.
 *
 * @returns la chaîne validée (relative ou absolue), ou `''` si invalide.
 *          Le caller traite `''` comme « pas de return » → fallback Hub.
 */
export function validateReturnUrl(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return '';

  // Forme 1 : path relatif interne Hub. `//` exclu (protocol-relative).
  if (value.startsWith('/') && !value.startsWith('//')) {
    return value;
  }

  // Forme 2 : URL absolue cross-domain → host doit être allowlisté + HTTPS.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:') return '';
  if (!ALLOWED_RETURN_HOSTS.includes(parsed.host)) return '';
  return parsed.toString();
}

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
