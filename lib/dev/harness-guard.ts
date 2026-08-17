/**
 * Garde-fou des routes d'atelier (`/dev/*`).
 *
 * Ces routes servent à travailler l'UI avec des données fictives, sans
 * session ni base de données. Elles ne doivent JAMAIS être joignables en
 * production.
 *
 * Trois verrous, et cette fois ils sont RÉELLEMENT indépendants :
 *
 *  1. **Build** — `next.config.js` n'ajoute l'extension `dev.tsx` à
 *     `pageExtensions` que hors production. En prod, `page.dev.tsx` n'est
 *     pas reconnu comme une page : la route n'existe pas dans le bundle.
 *  2. **Runtime** — cette fonction, appelée par `app/dev/layout.tsx`. Ce
 *     layout porte une extension NORMALE (`.tsx`), donc il est compilé dans
 *     TOUS les builds, prod comprise. C'est ce qui lui permet de couvrir
 *     pour de vrai le scénario « quelqu'un crée ou renomme un `page.tsx`
 *     sous `app/dev/` » — ce que l'ancien `layout.dev.tsx` ne pouvait pas
 *     faire, puisque le verrou 1 l'effaçait en même temps que la page
 *     (next-app-loader résout les layouts avec le même `pageExtensions` que
 *     les pages). Le « double verrou » annoncé jusqu'ici n'en était qu'un.
 *  3. **Middleware** — `authorized()` dans `auth.config.ts` refuse tout
 *     `/dev/*` dès que cette fonction dit non. Le middleware est compilé
 *     quoi qu'il arrive, y compris si les deux premiers verrous sautent.
 *
 * ── Politique : LISTE BLANCHE, défaut FERMÉ ──────────────────────────────
 *
 * L'ancienne version était une liste noire de signaux de production suivie
 * d'un `return true` : une valeur `DEPLOY_ENV` non anticipée (`prod-eu`,
 * `production-blue`, `live`) ou un futur domaine de prod (`hub.veridian.site`)
 * rouvrait l'atelier. Le garde-fou dépendait donc d'une convention de
 * déploiement, pas de sa propre logique.
 *
 * Désormais il faut un signal POSITIF d'environnement de travail pour
 * ouvrir. Absence de configuration = fermé.
 */

import { isProduction } from '@/utils/env';

/** Les seuls environnements de déploiement où l'atelier a le droit d'exister. */
const ENVIRONNEMENTS_ATELIER = ['dev', 'development', 'staging', 'local', 'test'];

export function isDevHarnessEnabled(): boolean {
  // Un domaine de production ferme tout, quelles que soient les autres
  // variables. C'est le seul verrou qui reste une liste noire, et c'est
  // volontaire : il ne peut qu'AJOUTER des fermetures.
  if (isProduction()) return false;

  const deployEnv = (process.env.DEPLOY_ENV || '').trim().toLowerCase();

  // DEPLOY_ENV renseigné : il tranche, et toute valeur inconnue ferme.
  if (deployEnv) return ENVIRONNEMENTS_ATELIER.includes(deployEnv);

  // Pas de DEPLOY_ENV : seul un NODE_ENV explicitement « poste de travail »
  // ouvre. Un environnement vide (NODE_ENV absent) reste fermé.
  const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
  return nodeEnv === 'development' || nodeEnv === 'test';
}
