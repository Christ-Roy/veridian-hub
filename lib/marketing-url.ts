/**
 * Résolution de l'URL marketing publique (site vitrine veridian.site).
 *
 * **Pourquoi** : depuis 2026-05-29, la home du Hub (`app.veridian.site/`)
 * n'est plus une landing page — le marketing est centralisé sur le site
 * vitrine statique `veridian.site` (CF Pages, bon SEO). La home du Hub
 * redirige donc :
 *   - user loggué      → `/dashboard`
 *   - user non-loggué  → cette URL marketing (page produit SaaS)
 *
 * **Configurable par ENV** `MARKETING_URL` pour pouvoir basculer la cible
 * sans redéployer le code :
 *   - tant que la page produit dédiée n'existe pas côté veridian-site, on
 *     pointe sur la racine `https://veridian.site` (jamais de 404)
 *   - une fois la page `/plateforme` livrée côté veridian-site, on bascule
 *     `MARKETING_URL=https://veridian.site/plateforme` dans l'ENV Dokploy
 *     prod — aucun rebuild Hub nécessaire.
 *
 * Défaut volontairement sur la **racine** (pas `/plateforme`) : fail-safe
 * anti-404 si l'ENV n'est pas posée.
 */

/** URL marketing par défaut si `MARKETING_URL` n'est pas configurée. */
const DEFAULT_MARKETING_URL = 'https://veridian.site';

/**
 * Env minimal lu par le helper. Index signature pour rester assignable
 * depuis `process.env` (ProcessEnv = Record<string, string | undefined>).
 */
export type MarketingUrlEnv = {
  MARKETING_URL?: string;
  /** Domaine du site vitrine (défaut https://veridian.site). Sert à la page produit. */
  VERIDIAN_SITE_URL?: string;
  [key: string]: string | undefined;
};

/**
 * Retourne l'URL marketing absolue vers laquelle rediriger un visiteur
 * non-loggué depuis la home du Hub.
 *
 * Trim le slash final pour éviter les `//` ; garantit un scheme `https://`.
 */
export function resolveMarketingUrl(
  env: MarketingUrlEnv = process.env,
): string {
  const raw = env.MARKETING_URL?.trim();
  const url = raw && raw.length > 0 ? raw : DEFAULT_MARKETING_URL;
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.includes('://') ? trimmed : `https://${trimmed}`;
}

/**
 * URL de la page produit/tarifs publique (`veridian.site/plateforme`).
 * Source de découverte des formules pour les CTA billing du Hub.
 *
 * Volontairement INDÉPENDANTE de `MARKETING_URL` : cette dernière sert au
 * routage de la home (`/`) et peut pointer ailleurs en dev (ex. le login
 * local). La page produit, elle, est une URL externe fixe du site vitrine.
 * Override possible via `VERIDIAN_SITE_URL` (défaut : https://veridian.site).
 */
export function resolvePlateformeUrl(env: MarketingUrlEnv = process.env): string {
  const raw = env.VERIDIAN_SITE_URL?.trim();
  const base = (raw && raw.length > 0 ? raw : DEFAULT_MARKETING_URL).replace(/\/+$/, '');
  const withScheme = base.includes('://') ? base : `https://${base}`;
  return `${withScheme}/plateforme`;
}
