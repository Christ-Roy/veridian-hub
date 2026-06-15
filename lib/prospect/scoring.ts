/**
 * Barème de scoring du réconciliateur events COMPORTEMENTAUX cold↔web.
 *
 * Ticket : todo/2026-06-15-reconciliateur-events-cold-web-prospect-scoring.md
 * Spec   : notifuse-veridian/todo/2026-06-15-SPEC-reconciliation-cold-web-events-hub.md
 * Standard : docs/CONTRAT-HUB.md §7.5 (event comportemental uniforme).
 *
 * Fonctions PURES (zéro I/O) — le calcul du score d'un event et l'agrégation
 * des signaux. L'ingestion (DB) vit dans `lib/prospect/ingest.ts`.
 *
 * Barème V1 (synchrone, simple — figé lead 2026-06-15) :
 *   - email.opened   → +1   (signal faible : pixel chargé, peut être un proxy mail)
 *   - email.clicked  → +5   (intention : le prospect a cliqué un lien)
 *   - email.replied  → +20  (signal fort : il répond → prospect chaud)
 *   - page.hit       → +3   (visite web — Analytics, étage 2 corrélé par vid)
 *
 * Un eventType inconnu vaut 0 (best-effort : on l'ingère pour forensics mais
 * il ne déplace pas le score). Le barème est volontairement additif et borné
 * par event ; pas de pondération temporelle au V1 (decay = feature post-volume).
 */

/** Type d'event comportemental canonique reconnu par le scoring. */
export type ProspectEventType =
  | 'email.opened'
  | 'email.clicked'
  | 'email.replied'
  | 'page.hit';

/** Barème points par event. Source de vérité unique du scoring. */
export const EVENT_SCORE: Readonly<Record<ProspectEventType, number>> = {
  'email.opened': 1,
  'email.clicked': 5,
  'email.replied': 20,
  'page.hit': 3,
} as const;

/** Clé de signal (compteur) dans `ProspectScore.signals` par eventType. */
const SIGNAL_KEY: Readonly<Record<ProspectEventType, string>> = {
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.replied': 'replied',
  'page.hit': 'page_hit',
} as const;

/** Les eventTypes que le scoring sait noter (les autres = 0, ingérés quand même). */
export const SCORABLE_EVENT_TYPES: readonly ProspectEventType[] = [
  'email.opened',
  'email.clicked',
  'email.replied',
  'page.hit',
] as const;

/** True si l'eventType est un event comportemental scorable connu. */
export function isProspectEventType(value: unknown): value is ProspectEventType {
  return (
    typeof value === 'string' &&
    (SCORABLE_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Points apportés par un event. eventType inconnu → 0 (non-régression :
 * on ingère tout, on ne score que le connu).
 */
export function scoreForEvent(eventType: string): number {
  return isProspectEventType(eventType) ? EVENT_SCORE[eventType] : 0;
}

/** Map des compteurs de signaux (JSONB `ProspectScore.signals`). */
export type ProspectSignals = Record<string, number>;

/**
 * Incrémente le compteur de signal correspondant à l'eventType.
 * Renvoie une NOUVELLE map (pure, ne mute pas l'entrée). Un eventType
 * inconnu laisse les signaux inchangés.
 */
export function bumpSignals(
  signals: ProspectSignals | null | undefined,
  eventType: string,
): ProspectSignals {
  const base: ProspectSignals = { ...(signals ?? {}) };
  if (!isProspectEventType(eventType)) return base;
  const key = SIGNAL_KEY[eventType];
  base[key] = (typeof base[key] === 'number' ? base[key] : 0) + 1;
  return base;
}
