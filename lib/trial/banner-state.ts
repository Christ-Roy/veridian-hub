/**
 * Agrégation de l'état trial pour le bandeau dashboard.
 *
 * La trial state machine (`lib/trial/run-tick.ts`, table `tenant_trials`)
 * suit un état PAR `(tenantId, app)` — un même user peut donc avoir un trial
 * Notifuse en `trial_active` et un trial Prospection en `trial_ending_soon`.
 *
 * Le bandeau du dashboard est global (un seul bandeau, en haut du layout) :
 * il doit donc fondre les N lignes `TenantTrial` du user en UN seul état
 * d'affichage. Ce module contient la fonction pure qui fait cette réduction —
 * aucune dépendance Prisma ici, pour rester testable unitairement.
 *
 * Règle métier (cf `docs/PRICING-VERIDIAN.md` §"Flow trial complet" et
 * §"Interdits côté code") :
 *
 *   - Phases 1-3 (signup → 5e mail → J+2) : SILENCE UI TOTAL. Aucun bandeau,
 *     aucun compteur. L'état machine correspondant est `eligible` (ou aucune
 *     ligne du tout). → bandeau masqué.
 *   - Phase 4 (J+2 après le 5e mail) : le trial est révélé. État machine
 *     `trial_active`. → bandeau sobre "essai en cours".
 *   - Phase 5 fin de trial proche : état `trial_ending_soon`. → bandeau
 *     positif invitant à ajouter une carte.
 *   - Expiration sans CB : état `expired`. → bandeau paywall + "Réactiver".
 *   - `converted` (subscription Stripe active) : plus de logique trial,
 *     bandeau masqué.
 *
 * Priorité d'agrégation quand le user a plusieurs apps en trial : on remonte
 * l'état le plus "urgent" pour l'user, car c'est celui qui demande une action.
 *   expired > trial_ending_soon > trial_active > (rien)
 */

import type { TrialStateString } from './transitions';

/**
 * État d'affichage du bandeau — distinct de `TrialStateString` (états machine)
 * car le bandeau ne distingue pas `eligible`/`converted`/absence de ligne :
 * tous ces cas ne montrent rien (`null`).
 */
export type TrialBannerPhase =
  | 'active' // trial révélé, en cours — bandeau sobre
  | 'ending_soon' // fin proche — invitation à ajouter une CB
  | 'expired'; // trial terminé, paywall — CTA réactiver

export interface TrialBannerState {
  phase: TrialBannerPhase;
}

/** Ligne minimale nécessaire à l'agrégation (sous-ensemble de `TenantTrial`). */
export interface TrialRowForBanner {
  state: TrialStateString;
}

// Plus le rang est élevé, plus l'état est prioritaire à afficher.
const STATE_PRIORITY: Record<TrialStateString, number> = {
  converted: 0,
  eligible: 0,
  trial_active: 1,
  trial_ending_soon: 2,
  expired: 3,
};

const STATE_TO_PHASE: Partial<Record<TrialStateString, TrialBannerPhase>> = {
  trial_active: 'active',
  trial_ending_soon: 'ending_soon',
  expired: 'expired',
};

/**
 * Réduit les lignes `tenant_trials` d'un user en un seul état de bandeau.
 *
 * @param rows  toutes les lignes TenantTrial des tenants du user (toutes apps)
 * @param hasActiveSubscription  true si le user a une subscription Stripe
 *   active/trialing — dans ce cas la logique trial ne s'applique plus, le
 *   bandeau est toujours masqué (le user paie déjà).
 * @returns `null` si aucun bandeau ne doit s'afficher (phases silencieuses),
 *   sinon l'état du bandeau.
 */
export function resolveTrialBannerState(
  rows: readonly TrialRowForBanner[],
  hasActiveSubscription: boolean,
): TrialBannerState | null {
  // Un user qui paie ne voit jamais de bandeau trial, quel que soit l'état
  // des lignes tenant_trials (elles devraient être `converted`, mais on ne
  // dépend pas de la propreté de la state machine pour ce garde-fou UX).
  if (hasActiveSubscription) return null;

  if (rows.length === 0) return null;

  // On retient la ligne au plus haut rang de priorité.
  let best: TrialStateString | null = null;
  let bestRank = -1;
  for (const row of rows) {
    const rank = STATE_PRIORITY[row.state] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = row.state;
    }
  }

  if (!best) return null;
  const phase = STATE_TO_PHASE[best];
  if (!phase) return null; // eligible / converted → silence

  return { phase };
}
