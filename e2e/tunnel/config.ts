/**
 * CONFIG du juge de paix tunnel — porté de
 * `veridian-tunnel-de-vente/tunnel-e2e/config.mjs` vers le HUB.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ CE QUI A CHANGÉ vs la référence bridge (l'écart structurel porté ici).     │
 * │                                                                            │
 * │   bridge (référence)            │   Hub (cible de ce portage)              │
 * │ ────────────────────────────────┼──────────────────────────────────────── │
 * │ store SQLite (docker exec)      │ Postgres `hub_app.prospect_events` +     │
 * │                                 │ `hub_app.prospect_scores` (runSqlOnStaging)│
 * │ scoring À L'INGESTION, push      │ events ⟂ scoring DÉCOUPLÉS : l'ingestion │
 * │ Twenty immédiat                 │ persiste, le cron push-prospect-scores   │
 * │                                 │ recalcule le score FROM-SCRATCH          │
 * │ score atterrit dans Twenty      │ score atterrit dans prospect_scores      │
 * │                                 │ (push Twenty LOGUÉ en DRY_RUN)           │
 * │ ancre `computeTunnelScore`      │ ancre `getScoringEngine('tunnel-v2')`    │
 * │ (bridge/src/score-tunnel.ts)    │ + aggregateSignals (lib/prospect/scoring)│
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Le POINT DE PARITÉ : on calcule le score attendu côté test avec le MÊME
 * scoring engine que le Hub utilise dans son cron (`tunnel-v2`), à partir des
 * MÊMES events. Score DB == score attendu => parité bridge↔Hub prouvée.
 */

import { RUN_STAMP } from '../staging-full/_helpers';

/** Cible : le Hub staging (et NON le bridge dev-pub). */
export const STAGING_URL =
  process.env.STAGING_URL || 'https://hub.staging.veridian.site';

/**
 * Workspace slug isolé par RUN_STAMP — n'a PAS besoin d'exister comme tenant
 * Hub (le réconciliateur ingère un workspace orphelin, tenant_uuid NULL : c'est
 * le comportement best-effort/forensics attendu, cf spec 21). Garantit
 * l'isolation totale : aucun autre prospect ne partage ce slug, cleanup ciblé.
 */
export const WORKSPACE_SLUG = `tunnel-e2e-${RUN_STAMP}`;

/**
 * GARDE-FOU D'ÉCRITURE (porté de `gateWriteAllowlist` du bridge). SEULS ces
 * emails de test (domaine @e2e.veridian.site) sont touchés par le juge de paix.
 * Tout email hors de cette allowlist = REFUS (préflight G0). Combiné au
 * workspace slug unique, ça rend impossible de polluer un vrai prospect.
 *
 * 5 "providerClass" (porté de la famille persistante test-tunnel-* du bridge) —
 * ici purement cosmétique (le Hub ne route pas par provider class au scoring),
 * conservé pour la parité du parcours simulé.
 */
export const TEST_PROSPECTS = [
  { providerClass: 'google', email: `tunnel-e2e-google-${RUN_STAMP}@e2e.veridian.site` },
  { providerClass: 'microsoft', email: `tunnel-e2e-microsoft-${RUN_STAMP}@e2e.veridian.site` },
  { providerClass: 'yahoo_aol', email: `tunnel-e2e-yahoo-aol-${RUN_STAMP}@e2e.veridian.site` },
  { providerClass: 'freemail_fr', email: `tunnel-e2e-freemail-fr-${RUN_STAMP}@e2e.veridian.site` },
  { providerClass: 'corporate', email: `tunnel-e2e-corporate-${RUN_STAMP}@e2e.veridian.site` },
] as const;

export const TEST_EMAILS = TEST_PROSPECTS.map((p) => p.email);

/** Préfixe stable des emails de test → utilisé par le garde-fou d'allowlist. */
export const TEST_EMAIL_DOMAIN = '@e2e.veridian.site';
export const TEST_EMAIL_PREFIX = 'tunnel-e2e-';

/**
 * Vérité de l'allowlist (porté de gateWriteAllowlist) : un email est "test"
 * SSI il appartient au domaine de test ET porte le préfixe tunnel-e2e-. Toute
 * écriture/suppression hors de ce filtre est refusée par construction.
 */
export function isTestEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  return e.endsWith(TEST_EMAIL_DOMAIN) && e.includes(TEST_EMAIL_PREFIX);
}

// ─── Secrets (alignés sur spec 21 / spec 15 / spec 08 — auto-sourcés par le
// launcher depuis le container hub-staging, source de vérité). ──────────────

/** Legacy HMAC : signature `HMAC-SHA256(secret, "${ts}.${rawBody}")`. */
export const NOTIFUSE_HUB_WEBHOOK_SECRET =
  process.env.NOTIFUSE_HUB_WEBHOOK_SECRET ||
  // Fallback aligné spec 21 (valeur staging stable d'un push à l'autre).
  'a62b5fb7384c9228d9813c5262cb156374c3fb3b6f6f2a3ae4a969657f083683';

/** v1.4 Bearer : token webhook Notifuse (cf spec 08). */
export const NOTIFUSE_WEBHOOK_TOKEN =
  process.env.NOTIFUSE_WEBHOOK_TOKEN ||
  '6a68be1b9effd251386d0d25d04409cdda75575d79feee3de899c30dfa9b59f2';

/**
 * CRON_SECRET — Bearer du cron push-prospect-scores (G7-G8). Auto-sourcé du
 * container par le launcher (`scripts/e2e/tunnel-gates.sh`). PAS de fallback
 * crédible : sans lui, G7 échoue en 401 (et le préflight G0 le signale).
 */
export const CRON_SECRET = process.env.CRON_SECRET || '';

/**
 * Parcours email SIMULÉ de CHAQUE prospect (porté de SIMULATED_JOURNEY du bridge,
 * RESTREINT à la famille Notifuse — la seule ingérable via webhook au V1, cf.
 * en-tête gates.spec.ts "constats de portage"). Sert de base au score ATTENDU,
 * calculé via le MÊME scoring engine que le Hub (parité, jamais hardcodé).
 *
 * Mapping vers `aggregateSignals` (lib/prospect/scoring.ts), barème riche réel :
 *   - email.opened          → opened=true       → OPEN_FIRST  +5
 *   - email.clicked ×2       → clicks=2          → CLICK_FIRST 20 + CLICK_EXTRA 10 = +30
 *   - email.replied          → replied=true      → EMAIL_REPLIED +35
 *   somme = 70, ×1.5 récence (<48h) = 105 → cap 100 → CHAUD.
 *
 * Le 2e clic (2 event_ids distincts) prouve le palier CLICK_EXTRA (barème
 * progressif), pas seulement le premier clic — fidélité au barème porté.
 *
 * Famille Analytics (page.hit) : non injectable via webhook (n'arrive que par le
 * cron pull-analytics). G6 déclenche le vrai cron au lieu de fabriquer de faux
 * events (interdit de contourner la DB — règle d'or).
 */
export const SIMULATED_JOURNEY = {
  /** une ouverture email (pixel) — OPEN_FIRST +5, non cumulable. */
  emailOpened: true,
  /** deux clics distincts — CLICK_FIRST +20 + CLICK_EXTRA +10 = +30. */
  emailClicks: 2,
  /** une réponse directe — EMAIL_REPLIED +35, extension HUB, non cumulable. */
  emailReplied: true,
} as const;

export const TIMEOUTS = {
  /** propagation d'un webhook → row prospect_events visible en DB. */
  ingestMs: 30_000,
  /** intervalle de poll DB. */
  pollMs: 2_000,
  /** marge d'exécution du cron push-prospect-scores (N prospects). */
  cronMs: 90_000,
};
