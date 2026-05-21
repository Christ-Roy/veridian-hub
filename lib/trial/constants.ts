/**
 * Constantes business de la trial state machine.
 *
 * Décisions figées par Robert le 2026-05-21 (cf
 * `docs/PRICING-VERIDIAN.md` §"Flow trial complet" et
 * `todo/2026-05-21-trial-state-machine.md` §"Décisions à figer").
 *
 * Toute modification de ces constantes affecte le funnel d'acquisition
 * cross-app : changer la durée d'un trial, le délai de révélation, ou le
 * seuil de notification doit passer par une revue produit.
 */

/** Délai d'attente après réception du signal d'éligibilité avant d'activer le trial. */
export const TRIAL_ELIGIBLE_WAIT_HOURS = 48;

/** Durée totale du trial Pro à partir de l'activation. */
export const TRIAL_DURATION_DAYS = 15;

/** À partir de combien de jours dans le trial on envoie l'email "expire bientôt". */
export const TRIAL_NOTIFY_ENDING_SOON_DAYS = 12;

/** Apps supportées par la state machine. Cohérent avec les plans `NotifusePlan`
 * et le routage downstream du dispatcher. CMS n'a pas de signal d'engagement
 * clair (B2B service Robert), donc pas inclus à date. */
export const TRIAL_SUPPORTED_APPS = ['notifuse', 'prospection', 'analytics'] as const;

export type TrialApp = (typeof TRIAL_SUPPORTED_APPS)[number];

export function isTrialApp(value: unknown): value is TrialApp {
  return (
    typeof value === 'string' &&
    (TRIAL_SUPPORTED_APPS as readonly string[]).includes(value)
  );
}
