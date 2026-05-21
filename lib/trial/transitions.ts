/**
 * Pure helpers de la trial state machine.
 *
 * Aucune dépendance Prisma / Stripe / Notifuse ici — ce sont les fonctions
 * mathématiques qui décident "à un instant donné, quelle transition s'applique".
 * Permet de tester unitairement la logique métier sans toucher au monde.
 *
 * Les side effects (DB write, appel update-plan, envoi mail, alerte Telegram)
 * sont orchestrés dans `app/api/cron/trial-tick/route.ts` qui consomme ces
 * helpers.
 */

import {
  TRIAL_DURATION_DAYS,
  TRIAL_ELIGIBLE_WAIT_HOURS,
  TRIAL_NOTIFY_ENDING_SOON_DAYS,
} from './constants';

export type TrialStateString =
  | 'eligible'
  | 'trial_active'
  | 'trial_ending_soon'
  | 'expired'
  | 'converted';

export interface TrialRow {
  tenantId: string;
  app: string;
  state: TrialStateString;
  eligibleAt: Date | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  endingSoonNotified: boolean;
}

/**
 * Retourne vrai si le trial éligible doit être activé (eligible depuis ≥48h).
 */
export function shouldActivateTrial(row: TrialRow, now: Date): boolean {
  if (row.state !== 'eligible') return false;
  if (!row.eligibleAt) return false;
  const thresholdMs = TRIAL_ELIGIBLE_WAIT_HOURS * 60 * 60 * 1000;
  return now.getTime() - row.eligibleAt.getTime() >= thresholdMs;
}

/**
 * Retourne vrai si le user doit recevoir l'email "trial expire dans 3j"
 * (trial actif depuis ≥12j ET pas déjà notifié).
 */
export function shouldNotifyEndingSoon(row: TrialRow, now: Date): boolean {
  if (row.state !== 'trial_active') return false;
  if (row.endingSoonNotified) return false;
  if (!row.trialStartedAt) return false;
  const thresholdMs = TRIAL_NOTIFY_ENDING_SOON_DAYS * 24 * 60 * 60 * 1000;
  return now.getTime() - row.trialStartedAt.getTime() >= thresholdMs;
}

/**
 * Retourne vrai si le trial doit être finalisé (trial_active depuis ≥15j,
 * i.e. trial_ends_at est dépassé).
 *
 * Le caller décide ensuite, en fonction de l'état Stripe :
 *   - sub active → state=converted (pas de downgrade)
 *   - pas de sub → state=expired + appel update-plan plan=free
 */
export function shouldFinalizeTrial(row: TrialRow, now: Date): boolean {
  if (row.state !== 'trial_active') return false;
  if (!row.trialEndsAt) return false;
  return now.getTime() >= row.trialEndsAt.getTime();
}

/**
 * Calcule trial_ends_at à partir de l'instant d'activation.
 */
export function computeTrialEndsAt(activatedAt: Date): Date {
  const result = new Date(activatedAt.getTime());
  result.setUTCDate(result.getUTCDate() + TRIAL_DURATION_DAYS);
  return result;
}
