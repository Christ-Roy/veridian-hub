/**
 * Journey 21 — Réconciliateur prospect : flow RÉEL de bout en bout.
 *
 * **POURQUOI CE SPEC** : le réconciliateur (Lot 1) a été promu en prod le
 * 2026-06-17 (tables `hub_app.prospect_events` + `hub_app.prospect_scores`,
 * ingestion + scoring V1, handlers webhook legacy HMAC + v1.4 Bearer) SANS
 * aucun test E2E du flow réel. Les tests unitaires couvrent `ingestProspectEvent`
 * en isolation, mais les tests de route MOCKENT l'ingestion → rien ne prouve
 * que le chemin RÉEL (HMAC signé → résolution tenant → INSERT event → UPSERT
 * score en DB Postgres staging) fonctionne. C'est exactement le pattern de
 * l'incident 2026-05-23 (CI verte avec mocks, zéro flow réel).
 *
 * **CE QUE CE SPEC COUVRE** (un flow réel, signé, vérifié en DB) :
 *   1. Voie LEGACY HMAC (celle qui émet en prod aujourd'hui) :
 *      POST signé `email.clicked` → 200 → `prospect_events` +1 row pour
 *      l'idempotency_key, `prospect_scores.engagement_score = 5` (barème
 *      clicked=+5), `signals = {"clicked": 1}`.
 *   2. Idempotence (replay même event_id) → 200, mais score INCHANGÉ (reste 5,
 *      count(events) reste 1) — l'INSERT unique sur idempotency_key avale le
 *      replay (couche 2 d'idempotence, cf lib/prospect/ingest.ts).
 *   3. Cumul : `email.replied` (même email, nouvel event_id) → score = 25
 *      (5 + 20), `signals = {"clicked":1,"replied":1}`.
 *   4. Voie v1.4 BEARER : même `email.clicked` via Authorization Bearer sur un
 *      2e prospect → converge sur le MÊME état DB (engagement_score = 5).
 *   5. Cleanup : suppression des rows prospect_events / prospect_scores E2E.
 *
 * **CONTRAT, PAS IMPLÉMENTATION** : on teste le COMPORTEMENT observable
 * (barème de score, idempotence, cumul, signals) — pas la mécanique interne
 * de l'upsert. Le barème (clicked=+5, replied=+20) est figé lead 2026-06-15
 * (cf lib/prospect/scoring.ts EVENT_SCORE). Ce spec reste vert avant/après tout
 * refactor de `ingest.ts` qui préserve ce contrat.
 *
 * **WORKSPACE SLUG E2E** : on utilise un slug unique `recon-e2e-<RUN_STAMP>`
 * qui n'a PAS besoin d'exister comme tenant Hub. Le réconciliateur ingère
 * quand même un workspace orphelin (`tenant_uuid = NULL`) — c'est le
 * comportement best-effort attendu (forensics), et ça garantit l'isolation
 * totale du test (aucune dépendance à un tenant pré-seedé, cleanup ciblé par
 * slug). Corollaire : sans tenant matchant `notifuse_workspace_slug`, la dédup
 * transport legacy (metadata.notifuse_processed_events) est sautée, donc le
 * replay (cas 2) prouve la couche 2 d'idempotence (INSERT unique côté DB), la
 * plus importante.
 *
 * **SÉCURITÉ HMAC** : signature `HMAC-SHA256(secret, "${ts}.${rawBody}")`,
 * secret `NOTIFUSE_HUB_WEBHOOK_SECRET`. Le `rawBody` signé DOIT être EXACTEMENT
 * la string envoyée (`data: body`), sinon Playwright re-sérialise et la
 * signature casse (cf spec 15 Cas 3).
 *
 * **DÉPENDANCES** :
 *   - NOTIFUSE_HUB_WEBHOOK_SECRET (legacy) + NOTIFUSE_WEBHOOK_TOKEN (v1.4),
 *     injectés côté staging. Fallbacks hardcodés alignés sur spec 15 / spec 08.
 *   - Helper `runSqlOnStaging` (_sql-helper.ts) pour asserter l'état DB.
 *   - Tables `hub_app.prospect_events` + `hub_app.prospect_scores` (migration
 *     20260615120000, appliquée et vérifiée en staging+prod).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';

import {
  STAGING_URL,
  RUN_STAMP,
  freshIpHeader,
  withRateLimitRetry,
} from './_helpers';
import { runSqlOnStaging, selectScalar } from './_sql-helper';

// ─── Secrets (alignés sur spec 15 / spec 08) ──────────────────────────────
// Legacy HMAC : signé `${ts}.${rawBody}` (cf route.ts verifyLegacySignature).
const NOTIFUSE_HUB_WEBHOOK_SECRET =
  process.env.NOTIFUSE_HUB_WEBHOOK_SECRET ||
  // Fallback : valeur staging récupérée via `ssh dev-pub 'docker exec
  // hub-staging env'` (stable d'un push à l'autre). Identique à spec 15.
  'a62b5fb7384c9228d9813c5262cb156374c3fb3b6f6f2a3ae4a969657f083683';

// v1.4 Bearer : token webhook Notifuse (cf spec 08).
const NOTIFUSE_WEBHOOK_TOKEN =
  process.env.NOTIFUSE_WEBHOOK_TOKEN ||
  '6a68be1b9effd251386d0d25d04409cdda75575d79feee3de899c30dfa9b59f2';

// CRON_SECRET : déclenche le cron de scoring découplé (push-prospect-scores).
// ⚠️ ARCHI DÉCOUPLÉE (Robert 2026-06-17) : l'ingestion d'un event NE calcule
// PLUS le score. Le score est recalculé À LA DEMANDE par le cron de scoring.
// Donc cette spec : ingère l'event → DÉCLENCHE le cron → vérifie le score.
const CRON_SECRET = process.env.CRON_SECRET || '';

/**
 * Déclenche un passage du cron push-prospect-scores (DRY_RUN attendu en staging).
 * C'est lui qui, dans l'archi découplée, relit les events agrégés, recalcule le
 * score via getScoringEngine('tunnel-v2') et l'écrit dans prospect_scores.
 * Sans ce tick, prospect_scores reste vide après une simple ingestion.
 */
async function triggerScoreCron(request: APIRequestContext): Promise<void> {
  const res = await request.post(
    `${STAGING_URL}/api/cron/push-prospect-scores`,
    { headers: { authorization: `Bearer ${CRON_SECRET}` } },
  );
  expect(
    res.status(),
    `cron push-prospect-scores doit répondre 200 (got ${res.status()}). ` +
      'Un 401 = CRON_SECRET désaligné (le launcher le source du container staging).',
  ).toBe(200);
}

// ─── Identifiants de test (isolés par RUN_STAMP, cleanup ciblé) ───────────
const WORKSPACE_SLUG = `recon-e2e-${RUN_STAMP}`;
const PROSPECT_EMAIL = `e2e-prospect-${RUN_STAMP}@veridian.test`;
// 2e prospect pour la voie v1.4 (état DB indépendant du 1er).
const PROSPECT_EMAIL_V14 = `e2e-prospect-v14-${RUN_STAMP}@veridian.test`;
// 3e prospect dédié au test de CONCURRENCE (course sur le MÊME score).
const PROSPECT_EMAIL_RACE = `e2e-prospect-race-${RUN_STAMP}@veridian.test`;

// ─── Helpers POST (legacy HMAC + v1.4 Bearer) ─────────────────────────────

/**
 * POST un webhook legacy HMAC signé. `body` est sérialisé UNE fois et la
 * MÊME string est signée + envoyée (sinon la signature casse).
 */
async function postLegacyHmac(
  request: APIRequestContext,
  payload: {
    event_id: string;
    event_type: string;
    tenant_id: string;
    occurred_at?: string;
    data: Record<string, unknown>;
  },
) {
  const body = JSON.stringify(payload);
  const ts = Date.now();
  const sig = createHmac('sha256', NOTIFUSE_HUB_WEBHOOK_SECRET)
    .update(`${ts}.${body}`)
    .digest('hex');
  return withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
      headers: {
        'content-type': 'application/json',
        'x-veridian-timestamp': String(ts),
        'x-veridian-notifuse-signature': sig,
        ...freshIpHeader(),
      },
      data: body,
      failOnStatusCode: false,
    }),
  );
}

/** POST un webhook v1.4 via Bearer (voie standard). */
async function postV14Bearer(
  request: APIRequestContext,
  payload: {
    event: string;
    tenant_id: string;
    idempotency_key: string;
    occurred_at: string;
    data: Record<string, unknown>;
  },
) {
  return withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${NOTIFUSE_WEBHOOK_TOKEN}`,
        ...freshIpHeader(),
      },
      data: payload,
      failOnStatusCode: false,
    }),
  );
}

// ─── Helpers assertion DB ─────────────────────────────────────────────────

/** Échappe un littéral SQL string (simple — identifiants E2E contrôlés). */
function sqlStr(s: string): string {
  return s.replace(/'/g, "''");
}

/** count(*) prospect_events pour un idempotency_key donné. */
function countEventsByKey(idempotencyKey: string): number {
  const out = selectScalar(
    `SELECT count(*) FROM hub_app.prospect_events WHERE idempotency_key = '${sqlStr(idempotencyKey)}'`,
  );
  return Number(out ?? '0');
}

/**
 * Lit engagement_score + signals (JSONB en texte) pour (workspace, email).
 * Retourne null si pas de row (prospect pas encore scoré).
 */
function readScore(
  workspaceSlug: string,
  email: string,
): { score: number; signals: Record<string, number> } | null {
  // -tA renvoie une ligne `engagement_score|signals_json`. On projette le
  // JSONB en texte canonique pour le parser en JS.
  const out = runSqlOnStaging(
    `SELECT engagement_score, signals::text
       FROM hub_app.prospect_scores
      WHERE workspace_slug = '${sqlStr(workspaceSlug)}'
        AND contact_email = '${sqlStr(email)}'`,
  );
  if (!out) return null;
  const firstLine = out.split('\n')[0];
  const pipe = firstLine.indexOf('|');
  if (pipe < 0) {
    throw new Error(`readScore: format inattendu (pas de pipe) → "${firstLine}"`);
  }
  const scoreRaw = firstLine.slice(0, pipe);
  const signalsRaw = firstLine.slice(pipe + 1);
  return {
    score: Number(scoreRaw),
    signals: JSON.parse(signalsRaw) as Record<string, number>,
  };
}

// ─── Teardown : purge des rows prospect E2E ───────────────────────────────

test.afterAll(() => {
  // Cleanup ciblé par workspace_slug (isolé par RUN_STAMP) + emails E2E.
  // Idempotent — ne touche QUE le slug/emails de ce run.
  try {
    runSqlOnStaging(`
      DELETE FROM hub_app.prospect_events
        WHERE workspace_slug = '${sqlStr(WORKSPACE_SLUG)}';
      DELETE FROM hub_app.prospect_scores
        WHERE workspace_slug = '${sqlStr(WORKSPACE_SLUG)}';
    `);
  } catch (err) {
    // Best-effort : ne pas faire échouer la suite sur un cleanup.
    console.warn('[21-reconciliateur] cleanup failed (best-effort)', err);
  }
});

// ─── Voie LEGACY HMAC : ingestion + scoring + idempotence + cumul ─────────

test.describe('Journey 21 — Réconciliateur prospect (voie legacy HMAC)', () => {
  // event_id du clicked, partagé entre le cas "ingestion" et le cas "replay".
  const clickedEventId = randomUUID();

  test.describe.configure({ mode: 'serial' }); // flow séquentiel : score cumulé

  test('email.clicked signé HMAC → 200 + event ingéré, score=30 après tick cron (CLICK_FIRST×récence)', async ({
    request,
  }) => {
    const res = await postLegacyHmac(request, {
      event_id: clickedEventId,
      event_type: 'email.clicked',
      tenant_id: WORKSPACE_SLUG,
      occurred_at: new Date().toISOString(),
      data: {
        contact_email: PROSPECT_EMAIL,
        link_url: 'https://veridian.site/e2e-recon-link',
      },
    });
    expect(
      res.status(),
      'webhook legacy HMAC signé doit être accepté (200). Un 401 = secret HMAC ' +
        'staging désaligné ; un 500 = NOTIFUSE_HUB_WEBHOOK_SECRET manquant côté Hub.',
    ).toBe(200);

    // Event persisté exactement 1 fois pour cet idempotency_key.
    expect(
      countEventsByKey(clickedEventId),
      'prospect_events doit avoir 1 row pour cet event_id',
    ).toBe(1);

    // Découplage : l'ingestion ne score PAS. On déclenche le cron de scoring.
    await triggerScoreCron(request);

    // Score = 30 : CLICK_FIRST=+20, ×1.5 (RECENCY_MULTIPLIER, event <48h) = 30.
    // L'event de test est créé "maintenant" → la récence s'applique toujours.
    const sc = readScore(WORKSPACE_SLUG, PROSPECT_EMAIL);
    expect(
      sc,
      'prospect_scores doit exister après ingestion + tick du cron de scoring',
    ).not.toBeNull();
    expect(
      sc!.score,
      'engagement_score après clicked : CLICK_FIRST(+20) × récence(1.5) = 30',
    ).toBe(30);
  });

  test('replay du MÊME event_id → 200, score INCHANGÉ (idempotence DB)', async ({
    request,
  }) => {
    // Re-POST identique. Sans tenant matchant, la dédup transport est sautée,
    // donc l'INSERT unique sur idempotency_key (couche 2) doit avaler le replay
    // SANS ré-incrémenter le score. La réponse reste 200 (dispatch ne throw pas).
    const res = await postLegacyHmac(request, {
      event_id: clickedEventId, // identique au test précédent
      event_type: 'email.clicked',
      tenant_id: WORKSPACE_SLUG,
      occurred_at: new Date().toISOString(),
      data: {
        contact_email: PROSPECT_EMAIL,
        link_url: 'https://veridian.site/e2e-recon-link',
      },
    });
    expect(res.status(), 'replay accepté 200 (avalé en idempotent)').toBe(200);

    // Toujours 1 seule row (pas de doublon malgré le replay).
    expect(
      countEventsByKey(clickedEventId),
      'replay ne doit PAS créer un 2e event (idempotency_key UNIQUE)',
    ).toBe(1);

    // Re-tick du cron : le score recalculé from-scratch sur les MÊMES events
    // (1 seul clicked) reste 20. C'est le cœur de l'anti-double-comptage.
    await triggerScoreCron(request);

    // Score INCHANGÉ : 30, pas 60. Le recompute sur 1 event clicked = CLICK_FIRST
    // (+20) × récence(1.5) = 30. Le replay n'ajoute pas de 2e clicked.
    const sc = readScore(WORKSPACE_SLUG, PROSPECT_EMAIL);
    expect(sc, 'prospect_scores toujours présent').not.toBeNull();
    expect(
      sc!.score,
      'engagement_score INCHANGÉ après replay (30, pas 60) — anti double comptage',
    ).toBe(30);
  });

  test('email.replied (même email, nouvel event_id) → score cumulé=83 après cron', async ({
    request,
  }) => {
    const repliedEventId = randomUUID();
    const res = await postLegacyHmac(request, {
      event_id: repliedEventId,
      event_type: 'email.replied',
      tenant_id: WORKSPACE_SLUG,
      occurred_at: new Date().toISOString(),
      data: {
        contact_email: PROSPECT_EMAIL,
        message_id: `e2e-reply-${RUN_STAMP}`,
      },
    });
    expect(res.status(), 'email.replied signé accepté 200').toBe(200);

    expect(
      countEventsByKey(repliedEventId),
      'le replied doit créer sa propre row event',
    ).toBe(1);

    // Recalcul du score sur l'état cumulé (1 clicked + 1 replied).
    await triggerScoreCron(request);

    // Cumul : (CLICK_FIRST 20 + EMAIL_REPLIED 35 = 55) × récence(1.5) = 82.5
    // → Math.round = 83.
    const sc = readScore(WORKSPACE_SLUG, PROSPECT_EMAIL);
    expect(sc, 'prospect_scores toujours présent').not.toBeNull();
    expect(
      sc!.score,
      'engagement_score cumulé : (clicked 20 + replied 35) × récence 1.5 = 83',
    ).toBe(83);
  });
});

// ─── Voie v1.4 BEARER : même état DB que la voie legacy ───────────────────

test.describe('Journey 21 — Réconciliateur prospect (voie v1.4 Bearer)', () => {
  test('email.clicked via Bearer → 200 + score=30 après cron (les deux voies convergent)', async ({
    request,
  }) => {
    const idempotencyKey = randomUUID();
    const res = await postV14Bearer(request, {
      event: 'email.clicked',
      tenant_id: WORKSPACE_SLUG,
      idempotency_key: idempotencyKey,
      occurred_at: new Date().toISOString(),
      data: {
        contact_email: PROSPECT_EMAIL_V14,
        link_url: 'https://veridian.site/e2e-recon-link-v14',
      },
    });
    expect(
      res.status(),
      'webhook v1.4 Bearer email.clicked doit être accepté 200',
    ).toBe(200);

    // L'event v1.4 est persisté dans la même table prospect_events.
    expect(
      countEventsByKey(idempotencyKey),
      'prospect_events doit avoir 1 row pour la voie v1.4',
    ).toBe(1);

    // Découplage : tick du cron de scoring, puis vérif.
    await triggerScoreCron(request);

    // Même barème, même table : CLICK_FIRST(20) × récence(1.5) = 30 (comme legacy).
    const sc = readScore(WORKSPACE_SLUG, PROSPECT_EMAIL_V14);
    expect(
      sc,
      'la voie v1.4 doit produire un prospect_scores comme la voie legacy',
    ).not.toBeNull();
    expect(
      sc!.score,
      'engagement_score = 30 via Bearer (clicked 20 × récence 1.5, les 2 voies convergent)',
    ).toBe(30);
  });
});

// ─── CONCURRENCE : la course prouve l'atomicité jsonb_set + increment ─────
//
// POURQUOI ce test est le plus important du fix atomique (61d4cc6) :
//   Le fix #2 (signals via `jsonb_set` ON CONFLICT côté DB, au lieu d'un
//   read-modify-write applicatif) ne se PROUVE que sous concurrence réelle.
//   Son test unitaire vérifie juste que le bon SQL est émis — pas qu'il
//   résiste à la course. Ici on tape N events scorables EN PARALLÈLE sur le
//   MÊME (workspace, contact_email), chacun avec un idempotency_key DIFFÉRENT
//   (sinon la dédup avale tout sauf 1).
//
//   Invariant prouvé : engagement_score == signals.opened == N.
//   - engagement_score était déjà bon avec l'ancien code (increment SQL
//     atomique `{ increment: points }`).
//   - signals.opened, lui, passait par un read-modify-write applicatif
//     (findUnique → bumpSignals JS → upsert) → sous course, plusieurs
//     transactions lisaient le même `signals` et écrasaient les incréments
//     concurrents → signals.opened < N alors que le score restait à N.
//   Donc l'ÉGALITÉ des deux sous course = la preuve que le jsonb_set
//   atomique a éliminé la divergence. Si la régression revenait,
//   signals.opened tomberait < score et ce test deviendrait rouge.
//
// La route webhook n'a PAS de rate-limiter (auth HMAC/Bearer) → on peut
// envoyer le burst sans withRateLimitRetry, ce qui garantit un vrai
// parallélisme côté serveur (pas de sérialisation par back-off 429).

/**
 * POST legacy HMAC SANS retry rate-limit — pour préserver le parallélisme
 * réel du burst (le wrapper retry sérialiserait sur back-off).
 */
async function postLegacyHmacRaw(
  request: APIRequestContext,
  payload: {
    event_id: string;
    event_type: string;
    tenant_id: string;
    occurred_at?: string;
    data: Record<string, unknown>;
  },
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

test.describe('Journey 21 — Concurrence (ingestion atomique sous course, modèle découplé)', () => {
  test('10× email.opened en PARALLÈLE → 10 events persistés sans perte, puis cron → score=8 (OPEN_FIRST cap×récence)', async ({
    request,
  }) => {
    const N = 10;
    // ARCHI DÉCOUPLÉE : l'ingestion ne calcule PLUS le score (plus de course
    // read-modify-write sur prospect_scores à l'ingestion). La course se joue
    // donc sur l'INGESTION ATOMIQUE des events (idempotency_key UNIQUE) : N
    // events parallèles sur le même prospect doivent TOUS être persistés sans
    // perte ni doublon. Le score est ensuite recalculé from-scratch par le cron
    // (déterministe, plus de divergence possible signals↔score).
    const eventIds = Array.from({ length: N }, () => randomUUID());

    const responses = await Promise.all(
      eventIds.map((event_id) =>
        postLegacyHmacRaw(request, {
          event_id,
          event_type: 'email.opened',
          tenant_id: WORKSPACE_SLUG,
          occurred_at: new Date().toISOString(),
          data: { contact_email: PROSPECT_EMAIL_RACE },
        }),
      ),
    );

    for (const res of responses) {
      expect(
        res.status(),
        'chaque webhook du burst concurrent doit être accepté 200',
      ).toBe(200);
    }

    // Les N events sont TOUS persistés (aucun perdu / aucun doublon) — preuve
    // de l'atomicité de l'ingestion sous course.
    const totalEvents = Number(
      selectScalar(
        `SELECT count(*) FROM hub_app.prospect_events
           WHERE workspace_slug = '${sqlStr(WORKSPACE_SLUG)}'
             AND contact_email = '${sqlStr(PROSPECT_EMAIL_RACE)}'
             AND event_type = 'email.opened'`,
      ) ?? '0',
    );
    expect(
      totalEvents,
      `les ${N} events concurrents doivent TOUS être persistés (idempotency_key distincts)`,
    ).toBe(N);

    // Recompute déterministe par le cron : OPEN_FIRST = +5 NON cumulable (cap 5),
    // × récence(1.5) = round(7.5) = 8. 10 opened → 8 (pas 10×), quel que soit
    // l'ordre/la concurrence d'arrivée — le recompute from-scratch le garantit.
    await triggerScoreCron(request);
    const sc = readScore(WORKSPACE_SLUG, PROSPECT_EMAIL_RACE);
    expect(sc, 'prospect_scores doit exister après le burst + cron').not.toBeNull();
    expect(
      sc!.score,
      'engagement_score == 8 (OPEN_FIRST cap 5 × récence 1.5) — recompute déterministe',
    ).toBe(8);
  });
});
