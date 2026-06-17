/**
 * Helpers du juge de paix tunnel (Hub) — porté de
 * `veridian-tunnel-de-vente/tunnel-e2e/lib.mjs` + crm-assertions.mjs, adapté à
 * l'archi DÉCOUPLÉE du Hub (Postgres, cron de scoring séparé).
 *
 * Trois familles :
 *   1. POST webhook signé (legacy HMAC + v1.4 Bearer) → /api/webhooks/notifuse.
 *   2. Lecture de l'état RÉEL en DB staging (prospect_events / prospect_scores)
 *      via runSqlOnStaging — l'équivalent Hub de `bridgeSql` (qui lisait SQLite).
 *   3. ANCRE DE PARITÉ : on importe le MÊME scoring engine que le cron du Hub
 *      (`getScoringEngine('tunnel-v2')` + `aggregateSignals`) et on calcule le
 *      score attendu à partir des MÊMES events → score DB == attendu = parité.
 */

import { createHmac, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

// ANCRE DE PARITÉ — import RELATIF (pas l'alias `@/`) : Playwright transpile via
// esbuild et ne résout PAS les `paths` du tsconfig. On importe le VRAI module de
// prod (lib/prospect/scoring.ts) que le cron du Hub utilise → même code, même score.
import {
  aggregateSignals,
  getScoringEngine,
  type AggregableEvent,
  type ProspectScoreResult,
} from '../../lib/prospect/scoring';

import { freshIpHeader } from '../staging-full/_helpers';
import { runSqlOnStaging, selectScalar } from '../staging-full/_sql-helper';
import {
  CRON_SECRET,
  NOTIFUSE_HUB_WEBHOOK_SECRET,
  NOTIFUSE_WEBHOOK_TOKEN,
  STAGING_URL,
  WORKSPACE_SLUG,
} from './config';

export { runSqlOnStaging, selectScalar };

/** Échappe un littéral SQL string (identifiants E2E contrôlés). */
export function sqlStr(s: string): string {
  return s.replace(/'/g, "''");
}

/** Liste SQL quotée `'a','b'` (porté de sqlList du bridge). */
export function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${sqlStr(v)}'`).join(',');
}

// ─── POST webhooks signés (legacy HMAC + v1.4 Bearer) ─────────────────────────

/** Payload legacy HMAC tel qu'attendu par route.ts (event_id/event_type/...). */
export interface LegacyPayload {
  event_id: string;
  event_type: string;
  tenant_id: string;
  occurred_at?: string;
  data: Record<string, unknown>;
}

/**
 * POST un webhook legacy HMAC signé. La string sérialisée signée DOIT être
 * EXACTEMENT celle envoyée (sinon Playwright re-sérialise et la signature casse
 * — cf spec 21 / spec 15 Cas 3).
 */
export async function postLegacyHmac(
  request: APIRequestContext,
  payload: LegacyPayload,
) {
  const body = JSON.stringify(payload);
  const ts = Date.now();
  const sig = createHmac('sha256', NOTIFUSE_HUB_WEBHOOK_SECRET)
    .update(`${ts}.${body}`)
    .digest('hex');
  return request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
    headers: {
      'content-type': 'application/json',
      'x-veridian-timestamp': String(ts),
      'x-veridian-notifuse-signature': sig,
      ...freshIpHeader(),
    },
    data: body,
    failOnStatusCode: false,
  });
}

/** Payload v1.4 Bearer (event/tenant_id/idempotency_key/...). */
export interface V14Payload {
  event: string;
  tenant_id: string;
  idempotency_key: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

/** POST un webhook v1.4 via Bearer (voie standard des nouvelles apps). */
export async function postV14Bearer(
  request: APIRequestContext,
  payload: V14Payload,
) {
  return request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${NOTIFUSE_WEBHOOK_TOKEN}`,
      ...freshIpHeader(),
    },
    data: payload,
    failOnStatusCode: false,
  });
}

// ─── Déclenchement du cron de scoring découplé (G7-G8) ────────────────────────

export interface PushSummary {
  ok: boolean;
  candidates: number;
  scored: number;
  pushed: number;
  unchanged: number;
  noCrmTenant: number;
  personNotFound: number;
  errors: number;
  dryRun: boolean;
  engineId: string;
}

/**
 * Déclenche UN passage du cron `push-prospect-scores` (Bearer CRON_SECRET).
 * C'est le maillon DÉCOUPLÉ du Hub : il relit les events, recalcule le score
 * FROM-SCRATCH via l'engine, l'écrit en prospect_scores, et (en DRY_RUN) LOGUE
 * les mutations Twenty sans les envoyer. Retourne le summary JSON.
 */
export async function triggerPushCron(
  request: APIRequestContext,
  opts: { limit?: number } = {},
): Promise<PushSummary> {
  const url = new URL(`${STAGING_URL}/api/cron/push-prospect-scores`);
  if (opts.limit) url.searchParams.set('limit', String(opts.limit));
  const res = await request.post(url.toString(), {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
    failOnStatusCode: false,
  });
  if (res.status() !== 200) {
    const text = await res.text();
    throw new Error(
      `cron push-prospect-scores → ${res.status()} (attendu 200): ${text.slice(0, 300)}` +
        (res.status() === 401
          ? ' — CRON_SECRET désaligné/absent (le launcher tunnel-gates.sh le source du container).'
          : ''),
    );
  }
  return (await res.json()) as PushSummary;
}

/**
 * Déclenche UN passage du cron `pull-analytics` (Bearer CRON_SECRET). C'est la
 * SEULE voie d'ingestion des events web (page.hit) au V1 — pas de webhook web.
 * On vérifie juste que la voie EXISTE et tourne sans crasher (skipped:true est
 * accepté si ENGINE_ADMIN_* absents en staging : garde-fou propre, pas une
 * erreur). L'isolation/parité des events web est couverte par les tests du L4.
 */
export async function triggerPullAnalyticsCron(
  request: APIRequestContext,
): Promise<{ ok: boolean; skipped?: boolean }> {
  const res = await request.post(
    `${STAGING_URL}/api/cron/pull-analytics`,
    {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
      failOnStatusCode: false,
    },
  );
  if (res.status() !== 200) {
    const text = await res.text();
    throw new Error(
      `cron pull-analytics → ${res.status()} (attendu 200): ${text.slice(0, 300)}`,
    );
  }
  return (await res.json()) as { ok: boolean; skipped?: boolean };
}

// ─── Lecture de l'état RÉEL en DB staging (prospect_events / prospect_scores) ──

/** count(*) prospect_events pour un idempotency_key donné (dédup). */
export function countEventsByKey(idempotencyKey: string): number {
  const out = selectScalar(
    `SELECT count(*) FROM hub_app.prospect_events
       WHERE idempotency_key = '${sqlStr(idempotencyKey)}'`,
  );
  return Number(out ?? '0');
}

/** count(*) events d'un (workspace, email, eventType) — preuves de parcours. */
export function countEventsByType(
  workspaceSlug: string,
  email: string,
  eventType: string,
): number {
  const out = selectScalar(
    `SELECT count(*) FROM hub_app.prospect_events
       WHERE workspace_slug = '${sqlStr(workspaceSlug)}'
         AND contact_email = '${sqlStr(email)}'
         AND event_type = '${sqlStr(eventType)}'`,
  );
  return Number(out ?? '0');
}

export interface ScoreRow {
  score: number;
  label: string;
  disqualified: boolean;
  signals: Record<string, number>;
  components: Record<string, number>;
}

/**
 * Lit la row prospect_scores d'un (workspace, email). Retourne null si absente.
 * Projette les JSONB en texte canonique pour parsing JS (pattern spec 21).
 */
export function readScore(
  workspaceSlug: string,
  email: string,
): ScoreRow | null {
  const out = runSqlOnStaging(
    `SELECT engagement_score, label, disqualified, signals::text, components::text
       FROM hub_app.prospect_scores
      WHERE workspace_slug = '${sqlStr(workspaceSlug)}'
        AND contact_email = '${sqlStr(email)}'`,
  );
  if (!out) return null;
  const cols = out.split('\n')[0].split('|');
  if (cols.length < 5) {
    throw new Error(`readScore: format inattendu → "${out.split('\n')[0]}"`);
  }
  return {
    score: Number(cols[0]),
    label: cols[1],
    disqualified: cols[2] === 't',
    signals: JSON.parse(cols[3]) as Record<string, number>,
    components: JSON.parse(cols[4]) as Record<string, number>,
  };
}

/** Relit TOUS les events d'un prospect (forme AggregableEvent) — pour la parité. */
export function readEventsForProspect(
  workspaceSlug: string,
  email: string,
): AggregableEvent[] {
  // JSON line-delimited : on projette event_type, occurred_at ISO, data JSON.
  const out = runSqlOnStaging(
    `SELECT json_build_object(
        'eventType', event_type,
        'occurredAt', to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'data', data
      )::text
      FROM hub_app.prospect_events
     WHERE workspace_slug = '${sqlStr(workspaceSlug)}'
       AND contact_email = '${sqlStr(email)}'
     ORDER BY occurred_at ASC`,
  );
  if (!out) return [];
  return out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const o = JSON.parse(l) as {
        eventType: string;
        occurredAt: string;
        data: Record<string, unknown> | null;
      };
      return {
        eventType: o.eventType,
        occurredAt: new Date(o.occurredAt),
        data: o.data,
      };
    });
}

// ─── ANCRE DE PARITÉ : le MÊME scoring engine que le cron du Hub ──────────────

/**
 * Calcule le score ATTENDU d'un prospect à partir de SES events relus, via le
 * MÊME chemin que le cron `push-prospect-scores` : aggregateSignals → engine
 * 'tunnel-v2'. C'est la preuve de parité : on n'écrit PAS un barème en dur dans
 * le test, on rejoue le code de prod sur l'état réel. Score DB == ceci => les
 * deux côtés (bridge historique ⊃ Hub) calculent identiquement.
 *
 * `now` est figé pour que le multiplicateur de récence (×1.5 si <48h) soit
 * déterministe entre le calcul attendu et ce que le cron a fait (les events
 * sont tous très récents → récence active des deux côtés, mais on fige pour
 * éliminer toute fenêtre de bord).
 */
export function expectedScoreFromDb(
  workspaceSlug: string,
  email: string,
  now: Date = new Date(),
): ProspectScoreResult {
  const events = readEventsForProspect(workspaceSlug, email);
  const signals = aggregateSignals(email, events);
  return getScoringEngine('tunnel-v2').compute(signals, now);
}

// ─── Garde-fou global (porté de assertNoRealProspectTouched) ──────────────────

/**
 * GARDE-FOU : aucun prospect HORS du workspace slug de test ne doit avoir reçu
 * un score pendant le run. Équivalent Hub d'`assertNoRealProspectTouched` du
 * bridge (qui vérifiait isTestProspect=false côté Twenty). Ici la frontière est
 * le workspace_slug unique : tout score sur un email de test mais un AUTRE
 * workspace, ou un email hors allowlist dans NOTRE workspace, est une fuite.
 *
 * On vérifie que dans NOTRE workspace, 100 % des emails scorés sont des emails
 * de test (allowlist). C'est l'invariant : le réconciliateur n'a touché QUE le
 * périmètre test.
 */
export function assertOnlyTestEmailsScored(
  workspaceSlug: string,
  isTestEmail: (email: string) => boolean,
): void {
  const out = runSqlOnStaging(
    `SELECT contact_email FROM hub_app.prospect_scores
      WHERE workspace_slug = '${sqlStr(workspaceSlug)}'`,
  );
  if (!out) return;
  const leaked = out
    .split('\n')
    .map((e) => e.trim())
    .filter((e) => e.length > 0 && !isTestEmail(e));
  if (leaked.length > 0) {
    throw new Error(
      `FUITE: ${leaked.length} email(s) hors allowlist scoré(s) dans le workspace test ` +
        `${workspaceSlug} — ${leaked.join(', ')}. STOP.`,
    );
  }
}

/** Purge ciblée des rows E2E (events + scores) du workspace test. Idempotent. */
export function cleanupWorkspace(workspaceSlug: string): void {
  runSqlOnStaging(
    `DELETE FROM hub_app.prospect_events WHERE workspace_slug = '${sqlStr(workspaceSlug)}';
     DELETE FROM hub_app.prospect_scores WHERE workspace_slug = '${sqlStr(workspaceSlug)}';`,
  );
}

export { WORKSPACE_SLUG, randomUUID };
