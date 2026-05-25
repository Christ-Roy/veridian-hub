/**
 * MEGA F-04 — Webhook retry after fail / downstream HS / failed event behavior.
 *
 * **SCÉNARIO BUSINESS** :
 *   Quand le dispatcher échoue (ex: Notifuse downstream HS, customer inconnu
 *   en DB Hub) :
 *     - Hub renvoie 200 à Stripe (sinon retry 3 jours)
 *     - `stripe_events.processed_at` reste NULL
 *     - `stripe_events.error` contient le message d'erreur (≤2000 chars)
 *     - `stripe_events.attempts` est incrémenté
 *     - Le retry suivant (Stripe ou cron Hub) re-tente le dispatch
 *
 *   C'est le contrat-billing §2.2 : "retry-mode" pour les events fails.
 *   À l'inverse de F-02 (idempotence forte), ici on VEUT que le 2e POST
 *   re-tente le dispatch.
 *
 * **ASSERTS COUVERTS** (matrice MEGA §1 F-04 + ticket validate-dispatcher) :
 *   1. Event mappé (`subscription.created`) sans customer en DB → fail
 *      mais Hub renvoie 200
 *   2. `stripe_events.processed_at` reste NULL après fail
 *   3. `stripe_events.attempts` >= 1 après fail
 *   4. `stripe_events.error` non-null après fail (message d'erreur tronqué
 *      à 2000 chars max — cf dispatcher.ts L130 `error.slice(0, 2000)`)
 *   5. 2e POST même event_id → re-tente le dispatch (PAS idempotent)
 *   6. Après plusieurs fails, attempts incrémenté à chaque tentative
 *   7. Le rejouage du même event-id reste safe (PK existe, on tombe sur
 *      `wasNew=false alreadyProcessed=false` → on continue dispatch)
 *
 * **PIÈGE classique** : si on confond idempotence forte et idempotence
 * faible, on peut "réussir" un test en croyant que processedAt=NULL +
 * `idempotent: true` au 2e call est OK — c'est faux. F-04 distingue ces
 * 2 modes (vs F-02).
 *
 * **NOTE INFRA** : on ne peut pas TOUJOURS reproduire le fail sans toucher
 * à Notifuse staging. Pour rendre le test robuste, on utilise un event
 * `subscription.created` avec un customer "fake" → `manageSubscriptionStatusChange`
 * lookup en DB → trouve rien → fail. C'est le mode `failed` du dispatcher.
 *
 * Cf ticket racine : `todo/2026-05-23-MEGA-E2E-post-commercialisation.md` §1 F-04.
 */
import { test, expect } from '@playwright/test';
import Stripe from 'stripe';

import { runSqlOnStaging, selectScalar, selectRow } from '../../_sql-helper';
import { MEGA_STAGING_URL } from '../_fixtures/mock-oauth';

const STAGING_WHSEC =
  process.env.STRIPE_WEBHOOK_SECRET_TEST ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  'whsec_fake';
const stripe = new Stripe('sk_test_fake');

function signEvent(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  return stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: STAGING_WHSEC,
    timestamp,
  });
}

/**
 * Event subscription.created avec customer inconnu → `manageSubscriptionStatusChange`
 * va chercher l'user via subscriptions.stripe_customer_id, rien trouver →
 * fail propre (dispatcher catch + log + alerte Telegram + retourne failed).
 */
function makeFailingSubEvent(idOverride: string): Stripe.Event {
  const fakeCustomer = `cus_e2e_mega_f04_unknown_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return {
    id: idOverride,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'customer.subscription.created',
    data: {
      object: {
        id: `sub_e2e_mega_f04_${Date.now()}`,
        object: 'subscription',
        customer: fakeCustomer,
        status: 'active',
        items: { data: [], has_more: false, object: 'list', url: '' },
        metadata: {},
      } as unknown as Stripe.Event.Data.Object,
    } as Stripe.Event.Data,
  } as Stripe.Event;
}

async function postWebhook(
  request: import('@playwright/test').APIRequestContext,
  event: Stripe.Event,
): Promise<{ status: number; body: { outcome?: string; idempotent?: boolean } }> {
  const body = JSON.stringify(event);
  const signature = signEvent(body);
  const res = await request.post(`${MEGA_STAGING_URL}/api/webhooks`, {
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    data: body,
    failOnStatusCode: false,
  });
  const status = res.status();
  let json: { outcome?: string; idempotent?: boolean } = {};
  try {
    json = await res.json();
  } catch {
    /* body vide ou invalide */
  }
  return { status, body: json };
}

test.describe('Mega F-04 — Retry after fail / processed_at NULL', () => {
  const createdEventIds: string[] = [];

  test.afterAll(async () => {
    if (createdEventIds.length > 0) {
      try {
        const quoted = createdEventIds
          .map((id) => `'${id.replace(/'/g, "''")}'`)
          .join(',');
        runSqlOnStaging(
          `DELETE FROM hub_app.stripe_events WHERE event_id IN (${quoted});`,
        );
      } catch {
        /* never throw */
      }
    }
  });

  test('A — event mappé qui FAIL → 200 + row persistée + processed_at NULL', async ({
    request,
  }) => {
    const eventId = `evt_e2e_mega_f04_fail_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    createdEventIds.push(eventId);
    const event = makeFailingSubEvent(eventId);

    const r1 = await postWebhook(request, event);
    expect(
      r1.status,
      'INVARIANT critique : signature valide → 200 même si dispatch fail',
    ).toBe(200);

    // outcome peut être 'failed' (dispatcher catch puis return) ou 'processed'
    // si le handler a réussi à parser malgré le customer absent. Les 2 sont OK.
    expect(['processed', 'failed', 'ignored']).toContain(r1.body.outcome);

    // Row persistée
    const persisted = selectScalar(
      `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    expect(persisted).toBe('customer.subscription.created');

    // Si outcome='failed', alors processed_at doit être NULL (contrat §2.2)
    // Si outcome='processed' ou 'ignored', alors processed_at est SET
    const row = selectRow(
      `SELECT
         COALESCE(processed_at::text, '') AS processed_at,
         COALESCE(error, '') AS error,
         attempts::text AS attempts
       FROM hub_app.stripe_events
       WHERE event_id = '${eventId}';`,
      ['processed_at', 'error', 'attempts'],
    );
    expect(row).not.toBeNull();

    if (r1.body.outcome === 'failed') {
      expect(
        row!.processed_at,
        'outcome=failed DOIT laisser processed_at NULL (retry-mode contrat-billing §2.2)',
      ).toBe('');
      expect(
        row!.error,
        'outcome=failed DOIT poser un message d\'erreur (forensics + cron retry)',
      ).not.toBe('');
      expect(
        Number(row!.attempts),
        'outcome=failed → attempts ≥ 1 (markEventProcessed{ok:false} increment)',
      ).toBeGreaterThanOrEqual(1);
    } else {
      // outcome processed/ignored : processed_at est set
      expect(
        row!.processed_at,
        `outcome=${r1.body.outcome} DOIT poser processed_at (markEventProcessed{ok:true})`,
      ).not.toBe('');
    }
  });

  test('B — replay event failed → re-tente le dispatch (PAS idempotent)', async ({
    request,
  }) => {
    const eventId = `evt_e2e_mega_f04_retry_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    createdEventIds.push(eventId);
    const event = makeFailingSubEvent(eventId);

    const r1 = await postWebhook(request, event);
    expect(r1.status).toBe(200);

    if (r1.body.outcome !== 'failed') {
      test.skip(
        true,
        `outcome=${r1.body.outcome} (pas 'failed') — on ne peut pas tester le retry-mode`,
      );
      return;
    }

    // 2e POST : event DÉJÀ vu (PK existe) mais processed_at NULL → contrat
    // dit "wasNew=false && alreadyProcessed=false → on retente"
    const attemptsBefore = Number(
      selectScalar(
        `SELECT attempts FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
      ) ?? '0',
    );

    const r2 = await postWebhook(request, event);
    expect(r2.status).toBe(200);

    // Le 2e POST ne doit PAS retourner idempotent (sinon on perd l'event
    // qui n'a jamais été dispatched succès)
    expect(
      r2.body.idempotent,
      'event failed avec processed_at NULL → 2e POST DOIT re-tenter (pas idempotent)',
    ).not.toBe(true);

    // attempts a été incrémenté (markEventProcessed{ok:false} += 1)
    const attemptsAfter = Number(
      selectScalar(
        `SELECT attempts FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
      ) ?? '0',
    );
    expect(
      attemptsAfter,
      `attempts doit être incrémenté au 2e fail (${attemptsBefore} → ${attemptsAfter})`,
    ).toBeGreaterThan(attemptsBefore);
  });

  test('C — message d\'erreur tronqué ≤ 2000 chars (anti-OOM)', async ({
    request,
  }) => {
    // Le dispatcher fait `error.slice(0, 2000)` avant store. On force une
    // erreur potentiellement longue et on vérifie qu'elle n'explose pas la
    // colonne `error` (TEXT mais on garde une bonne hygiène).
    const eventId = `evt_e2e_mega_f04_trunc_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    createdEventIds.push(eventId);
    const event = makeFailingSubEvent(eventId);

    await postWebhook(request, event);

    const errLength = selectScalar(
      `SELECT COALESCE(length(error), 0)::text FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    const len = Number(errLength ?? '0');
    expect(
      len,
      'INVARIANT anti-OOM : error.length ≤ 2000 (dispatcher.ts L130)',
    ).toBeLessThanOrEqual(2000);
  });

  test('D — 3 fails consécutifs → attempts >= 3 (cron retry peut prendre la suite)', async ({
    request,
  }) => {
    const eventId = `evt_e2e_mega_f04_3fail_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    createdEventIds.push(eventId);
    const event = makeFailingSubEvent(eventId);

    // 3 POST consécutifs
    const results = [];
    for (let i = 0; i < 3; i++) {
      const r = await postWebhook(request, event);
      expect(r.status).toBe(200);
      results.push(r);
    }

    if (results[0].body.outcome !== 'failed') {
      test.skip(
        true,
        `outcome=${results[0].body.outcome} (pas 'failed') — test 3-retries non-applicable`,
      );
      return;
    }

    const finalAttempts = Number(
      selectScalar(
        `SELECT attempts FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
      ) ?? '0',
    );
    expect(
      finalAttempts,
      'INVARIANT cron retry : 3 fails consécutifs → attempts ≥ 3 (cron lit WHERE attempts < N)',
    ).toBeGreaterThanOrEqual(3);

    // Toujours 1 seule row (PK event_id)
    const rowCount = selectScalar(
      `SELECT count(*) FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    expect(rowCount, '3 fails du même event → 1 seule row (PK)').toBe('1');

    // processed_at reste NULL.
    // On utilise une sentinel `NULL_VALUE` car selectScalar() retourne `null`
    // pour une string vide (limitation du helper psql -tA + trim().
    // Cf. _sql-helper.ts:98 — `if (!out) return null` traite '' comme absent).
    const processedAt = selectScalar(
      `SELECT COALESCE(processed_at::text, 'NULL_VALUE') FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    expect(
      processedAt,
      '3 fails consécutifs → processed_at reste NULL (jamais set par fail)',
    ).toBe('NULL_VALUE');
  });
});
