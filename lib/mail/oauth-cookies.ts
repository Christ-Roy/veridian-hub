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
 * Construit la redirect URI exacte attendue par Google OAuth Client 2.
 * Doit matcher les URIs déclarées en Console (prod / staging / localhost).
 */
export function buildRedirectUri(origin: string): string {
  return `${origin}/api/gmail/connect/callback`;
}
