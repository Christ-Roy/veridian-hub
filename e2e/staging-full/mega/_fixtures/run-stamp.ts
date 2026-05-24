/**
 * MEGA fixture — `run-stamp.ts`
 *
 * Identifiant unique du run MEGA courant. Calculé UNE fois au load du
 * module (= 1 par invocation Playwright, partagé par tous les workers
 * via inheritance du process parent).
 *
 * **POURQUOI un fichier dédié** : éviter import circulaire entre helpers
 * (mock-oauth, db-purge, audit-log, downstream-db importent tous le
 * RUN_STAMP). En l'isolant, chaque helper peut l'importer sans tirer
 * la dépendance Playwright.
 *
 * **Format** : `<timestamp-ms>-<rand>` (ex: `1716566612345-x9k2`).
 *   - timestamp pour traçabilité humaine ("ce reliquat date du run de 14h33")
 *   - rand pour éviter collision si 2 runs démarrent à la même milliseconde
 *
 * **Override via ENV** : pour debug/replay, `MEGA_RUN_STAMP=abc` permet
 * de réutiliser un stamp connu. Utile aussi pour les scripts manuels
 * (`mega-purge.sh --stamp abc`).
 */
export const MEGA_RUN_STAMP =
  process.env.MEGA_RUN_STAMP ||
  `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Préfixe email canonique de la suite MEGA. À utiliser pour les LIKE
 * patterns SQL côté cleanup ("email LIKE 'e2e-mega-%@e2e.veridian.site'").
 */
export const MEGA_EMAIL_PREFIX = 'e2e-mega-';
export const MEGA_EMAIL_DOMAIN = '@e2e.veridian.site';

/**
 * Préfixe tenant canonique de la suite MEGA. À utiliser pour LIKE 'mega-%'.
 */
export const MEGA_TENANT_PREFIX = 'mega-';
