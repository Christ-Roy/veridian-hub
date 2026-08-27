/**
 * Journey 21 — Bus d'events prospect : flow RÉEL de bout en bout.
 *
 * **ARCHI (Robert 2026-06-17)** : le Hub est un BUS D'EVENTS. Il reçoit les
 * events comportementaux (Notifuse open/click/reply/sent, Analytics page.hit),
 * les PERSISTE dans `hub_app.prospect_events` (temps réel, idempotent), et les
 * relaie au CRM du tenant. Le Hub ne calcule NI ne stocke aucun score — le
 * scoring vit dans le CRM Twenty de chaque tenant (réglable par workspace). La
 * table `prospect_scores` a été supprimée (migration 20260617160000).
 *
 * **CE QUE CE SPEC COUVRE** (un flow réel, signé, vérifié en DB) :
 *   1. Voie LEGACY HMAC (celle qui émet en prod) : POST signé `email.clicked`
 *      → 200 → `prospect_events` +1 row pour l'idempotency_key.
 *   2. Idempotence (replay même event_id) → 200, mais count(events) reste 1
 *      (INSERT unique sur idempotency_key, couche 2, cf lib/prospect/ingest.ts).
 *   3. Voie v1.4 BEARER : même `email.clicked` via Authorization Bearer → la
 *      MÊME table prospect_events (les deux voies convergent sur ingestProspectEvent).
 *   4. Concurrence : N events parallèles → tous persistés sans perte ni doublon
 *      (ingestion atomique sous course, idempotency_key UNIQUE).
 *   5. Cleanup : suppression des rows prospect_events E2E.
 *
 * **CONTRAT, PAS IMPLÉMENTATION** : on teste le COMPORTEMENT observable du bus
 * (event persisté, idempotence, convergence des 2 voies) — aucune notion de score.
 *
 * **WORKSPACE SLUG E2E** : slug unique `recon-e2e-<RUN_STAMP>` qui n'a PAS besoin
 * d'exister comme tenant Hub. Le bus ingère un workspace orphelin (tenant_uuid
 * NULL) — comportement best-effort attendu (forensics) + isolation totale du test.
 *
 * **SÉCURITÉ HMAC** : signature `HMAC-SHA256(secret, "${ts}.${rawBody}")`. Le
 * `rawBody` signé DOIT être EXACTEMENT la string envoyée (`data: body`).
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
const NOTIFUSE_HUB_WEBHOOK_SECRET =
  process.env.NOTIFUSE_HUB_WEBHOOK_SECRET ||
  'FAKE-e2e-notifuse-hub-webhook-secret-do-not-use-in-prod';

const NOTIFUSE_WEBHOOK_TOKEN =
  process.env.NOTIFUSE_WEBHOOK_TOKEN ||
  'FAKE-e2e-notifuse-webhook-token-do-not-use-in-prod';

// ─── Identifiants de test (isolés par RUN_STAMP, cleanup ciblé) ───────────
const WORKSPACE_SLUG = `recon-e2e-${RUN_STAMP}`;
const PROSPECT_EMAIL = `e2e-prospect-${RUN_STAMP}@veridian.test`;
const PROSPECT_EMAIL_V14 = `e2e-prospect-v14-${RUN_STAMP}@veridian.test`;
const PROSPECT_EMAIL_RACE = `e2e-prospect-race-${RUN_STAMP}@veridian.test`;

// ─── Helpers POST (legacy HMAC + v1.4 Bearer) ─────────────────────────────

/** POST un webhook legacy HMAC signé. `body` sérialisé une fois et signé tel quel. */
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

/** POST legacy HMAC SANS retry rate-limit — préserve le parallélisme du burst. */
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

/** count(*) prospect_events pour (workspace, email, type). */
function countEvents(
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

// ─── Teardown : purge des rows prospect E2E ───────────────────────────────

test.afterAll(() => {
  try {
    runSqlOnStaging(`
      DELETE FROM hub_app.prospect_events
        WHERE workspace_slug = '${sqlStr(WORKSPACE_SLUG)}';
    `);
  } catch (err) {
    console.warn('[21-bus-events] cleanup failed (best-effort)', err);
  }
});

// ─── Voie LEGACY HMAC : ingestion + idempotence ───────────────────────────

test.describe('Journey 21 — Bus d\'events prospect (voie legacy HMAC)', () => {
  const clickedEventId = randomUUID();

  test.describe.configure({ mode: 'serial' });

  test('email.clicked signé HMAC → 200 + event persisté dans prospect_events', async ({
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
  });

  test('replay du MÊME event_id → 200, AUCUN doublon (idempotence DB)', async ({
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
    expect(res.status(), 'replay accepté 200 (avalé en idempotent)').toBe(200);

    // Toujours 1 seule row — l'idempotency_key UNIQUE avale le replay.
    expect(
      countEventsByKey(clickedEventId),
      'replay ne doit PAS créer un 2e event (idempotency_key UNIQUE)',
    ).toBe(1);
  });

  test('email.replied (même email, nouvel event_id) → sa propre row event', async ({
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
    // Le prospect a maintenant 2 events (clicked + replied) dans le bus.
    expect(
      countEvents(WORKSPACE_SLUG, PROSPECT_EMAIL, 'email.clicked') +
        countEvents(WORKSPACE_SLUG, PROSPECT_EMAIL, 'email.replied'),
      'le bus doit avoir clicked + replied pour ce prospect',
    ).toBe(2);
  });
});

// ─── Voie v1.4 BEARER : même table prospect_events ────────────────────────

test.describe('Journey 21 — Bus d\'events prospect (voie v1.4 Bearer)', () => {
  test('email.clicked via Bearer → 200 + event dans prospect_events (les 2 voies convergent)', async ({
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

    // L'event v1.4 est persisté dans la MÊME table prospect_events que la voie legacy.
    expect(
      countEventsByKey(idempotencyKey),
      'prospect_events doit avoir 1 row pour la voie v1.4 (convergence des 2 voies)',
    ).toBe(1);
  });
});

// ─── CONCURRENCE : ingestion atomique sous course ─────────────────────────
//
// Le Hub est un bus : la course se joue sur l'INGESTION ATOMIQUE des events
// (idempotency_key UNIQUE). N events parallèles sur le même prospect doivent
// TOUS être persistés, sans perte ni doublon. Aucun scoring impliqué.

test.describe('Journey 21 — Concurrence (ingestion atomique du bus sous course)', () => {
  test('10× email.opened en PARALLÈLE → 10 events tous persistés, zéro perte/doublon', async ({
    request,
  }) => {
    const N = 10;
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

    // Les N events sont TOUS persistés (aucun perdu / aucun doublon).
    expect(
      countEvents(WORKSPACE_SLUG, PROSPECT_EMAIL_RACE, 'email.opened'),
      `les ${N} events concurrents doivent TOUS être persistés (idempotency_key distincts)`,
    ).toBe(N);
  });
});
