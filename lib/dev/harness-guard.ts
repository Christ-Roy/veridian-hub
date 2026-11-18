/**
 * Garde-fou des routes d'atelier (`/dev/*`).
 *
 * Ces routes servent à travailler l'UI avec des données fictives, sans
 * session ni base de données. Elles ne doivent JAMAIS être joignables en
 * production.
 *
 * Deux verrous indépendants, volontairement redondants :
 *
 *  1. **Build** — `next.config.js` n'ajoute l'extension `dev.tsx` à
 *     `pageExtensions` que hors production. En prod, `page.dev.tsx` n'est
 *     pas reconnu comme une page : la route n'existe pas dans le bundle.
 *  2. **Runtime** — cette fonction, appelée par le layout d'atelier, qui
 *     renvoie un 404 si le moindre signal indique la production.
 *
 * Le second verrou couvre le cas où quelqu'un renommerait un fichier
 * d'atelier en `page.tsx` par mégarde.
 */

import { isProduction } from '@/utils/env';

export function isDevHarnessEnabled(): boolean {
  // Build/exécution en mode production Next : jamais d'atelier.
  if (process.env.NODE_ENV === 'production') return false;

  // Déploiement marqué production (variable injectée par le job Nomad).
  const deployEnv = (process.env.DEPLOY_ENV || '').trim().toLowerCase();
  if (deployEnv === 'production' || deployEnv === 'prod') return false;

  // Détection par domaine (app.veridian.site) — cf. `utils/env.ts`.
  if (isProduction()) return false;

  return true;
}
