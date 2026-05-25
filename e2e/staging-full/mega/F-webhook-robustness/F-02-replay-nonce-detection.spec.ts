/**
 * MEGA F-02 — Webhook replay/nonce detection (idempotence forte).
 *
 * **SCÉNARIO BUSINESS** :
 *   Stripe garantit "at-least-once" delivery — un même event peut arriver
 *   plusieurs fois. Le Hub doit absolument être idempotent sinon :
 *     - Double upgrade tenant (`plan='pro'` posé 2× → 2 dispatches HMAC
 *       vers Notifuse/Prospection → potentiellement 2× welcome leads grant)
 *     - Double facturation côté client (Stripe ne re-facture pas mais
 *       Veridian pourrait crédit/dispatch 2 fois sur l'event)
 *
 *   Mécanisme Hub : PK `stripe_events.event_id` (cf. dispatcher.ts L83
 *   `persistStripeEvent`). 1er call → insert + dispatch + processedAt set.
 *   2e+ calls → findUnique trouve la row → renvoie `idempotent: true`
 *   SANS re-dispatcher.
 *
 * **ASSERTS COUVERTS** (matrice MEGA §1 F-01 idempotence) :
 *   1. 1 seule row `stripe_events` par event_id (PK garantit)
 *   2. 2e+ POST avec MÊME event.id (signature ré-générée timestamp neuf)
 *      → 200 `idempotent: true`
 *   3. Le 1er dispatch doit avoir set `processed_at` (sinon idempotence
 *      tombe en retry-mode — c'est le contract-billing §2.2 explicit)
 *   4. Les replays N'incrémentent PAS `attempts` (déjà processedAt set)
 *   5. Aucun side-effect côté apps downstream (impossible à vérifier
 *      directement en E2E, mais l'invariant `outcome` et `idempotent: true`
 *      au 2e prouve qu'on n'a pas re-call manageSubscriptionStatusChange)
 *   6. Test cumulé sur 3 events distincts en parallèle (chacun envoyé 3×)
 *      pour valider que l'idempotence est PAR event_id, pas globale
 *
 * **NOTE DESIGN** (héritée du spec 14 S7 + ticket MEGA §1 F-01) :
 *   - Un event qui FAIL côté handler garde `processedAt=NULL` → le 2e call
 *     re-tente (comportement attendu pour retry Stripe).
 *   - On utilise donc des events `product.created` ou `ping` qui sont
 *     "ignored" → outcome 'ignored' → `markEventProcessed({ok:true})` set
 *     `processedAt` → idempotence active.
 *
 * Cf ticket racine : `todo/2026-05-23-MEGA-E2E-post-commercialisation.md` §1 F-01.
 */
import { test, expect, type APIResponse } from '@playwright/test';
import Stripe from 'stripe';

import { runSqlOnStaging, selectScalar } from '../../_sql-helper';
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

function makeIgnoredEvent(idOverride: string, eventType = 'product.created'): Stripe.Event {
  return {
    id: idOverride,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: eventType as Stripe.Event.Type,
    data: {
      object: {
        id: `prod_e2e_${Date.now()}`,
        object: 'product',
        name: 'F-02 replay product',
        active: true,
      } as unknown as Stripe.Event.Data.Object,
    } as Stripe.Event.Data,
  } as Stripe.Event;
}

async function postWebhook(
  request: import('@playwright/test').APIRequestContext,
  body: string,
): Promise<APIResponse> {
  const signature = signEvent(body);
  return request.post(`${MEGA_STAGING_URL}/api/webhooks`, {
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    data: body,
    failOnStatusCode: false,
  });
}

test.describe('Mega F-02 — Replay nonce/event detection', () => {
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

  test('A — replay 3× même event.id → 1 row + idempotent au 2e+', async ({
    request,
  }) => {
    const eventId = `evt_e2e_mega_f02_3x_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    createdEventIds.push(eventId);
    const body = JSON.stringify(makeIgnoredEvent(eventId));

    const results: Array<{ idempotent?: boolean; outcome?: string }> = [];
    for (let i = 0; i < 3; i++) {
      const res = await postWebhook(request, body);
      expect(
        res.status(),
        `replay #${i + 1} doit 200 (sinon Stripe retry 3j)`,
      ).toBe(200);
      const json = (await res.json()) as {
        idempotent?: boolean;
        outcome?: string;
      };
      results.push(json);
    }

    // 1er call : event neuf, pas idempotent
    expect(results[0].idempotent).not.toBe(true);
    expect(['ignored', 'processed']).toContain(results[0].outcome);

    // 2e et 3e : DOIVENT être idempotents
    expect(
      results[1].idempotent,
      'replay #2 doit retourner idempotent=true (PK stripe_events déjà set)',
    ).toBe(true);
    expect(
      results[2].idempotent,
      'replay #3 doit retourner idempotent=true (idempotence stable)',
    ).toBe(true);

    // INVARIANT : exactement 1 row
    const rowCount = selectScalar(
      `SELECT count(*) FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    expect(rowCount, 'PK event_id : 3 replays = 1 row').toBe('1');

    // processed_at est set
    const processedAt = selectScalar(
      `SELECT COALESCE(processed_at::text, '') FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    expect(
      processedAt,
      'processed_at doit être set au 1er call pour activer l\'idempotence',
    ).not.toBe('');

    // attempts ne doit pas dépasser 1 (replays ne re-incrémentent pas)
    const attempts = selectScalar(
      `SELECT attempts FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    expect(
      Number(attempts ?? '999'),
      'attempts doit rester ≤1 sur replays idempotents (pas de re-mark)',
    ).toBeLessThanOrEqual(1);
  });

  test('B — 3 events distincts × 2 replays chacun → idempotence par event_id', async ({
    request,
  }) => {
    // Sanity : l'idempotence est PAR event_id (PK), pas globale. On envoie
    // 3 events différents, chacun 2 fois, et on vérifie :
    //  - 3 rows distinctes en DB (1 par event_id)
    //  - chaque 2e POST est idempotent (par rapport à son event)
    const eventIds = Array.from({ length: 3 }, (_, i) =>
      `evt_e2e_mega_f02_multi_${i}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    );
    eventIds.forEach((id) => createdEventIds.push(id));

    const bodies = eventIds.map((id) => JSON.stringify(makeIgnoredEvent(id)));

    // Round 1 : tous les 3 events → tous NEW
    const round1 = await Promise.all(bodies.map((b) => postWebhook(request, b)));
    for (const res of round1) {
      expect(res.status()).toBe(200);
      const json = await res.json();
      expect(json.idempotent).not.toBe(true);
    }

    // Round 2 : tous les 3 events → tous idempotents
    const round2 = await Promise.all(bodies.map((b) => postWebhook(request, b)));
    for (let i = 0; i < 3; i++) {
      expect(round2[i].status()).toBe(200);
      const json = await round2[i].json();
      expect(
        json.idempotent,
        `event ${eventIds[i]} round2 doit être idempotent`,
      ).toBe(true);
    }

    // Vérif DB : 3 rows distinctes
    const quoted = eventIds.map((id) => `'${id}'`).join(',');
    const totalCount = selectScalar(
      `SELECT count(*) FROM hub_app.stripe_events WHERE event_id IN (${quoted});`,
    );
    expect(totalCount, '3 events distincts → 3 rows').toBe('3');
  });

  test('C — replay avec event_id différent mais payload identique → 2 rows (PAS idempotent)', async ({
    request,
  }) => {
    // CRITIQUE : l'idempotence est sur event.id (PK), PAS sur payload.
    // Stripe peut envoyer 2 events DIFFÉRENTS avec le même payload (ex:
    // 2 subscriptions du même user à 1s d'intervalle). Les 2 doivent être
    // traités indépendamment.
    const eventId1 = `evt_e2e_mega_f02_distinct_1_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const eventId2 = `evt_e2e_mega_f02_distinct_2_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    createdEventIds.push(eventId1, eventId2);

    const event1 = makeIgnoredEvent(eventId1);
    const event2 = makeIgnoredEvent(eventId2);
    // Force le même payload data (même product.id)
    (event2.data.object as { id?: string }).id = (event1.data.object as { id: string }).id;

    const res1 = await postWebhook(request, JSON.stringify(event1));
    const res2 = await postWebhook(request, JSON.stringify(event2));

    expect(res1.status()).toBe(200);
    expect(res2.status()).toBe(200);
    const j1 = await res1.json();
    const j2 = await res2.json();
    expect(j1.idempotent).not.toBe(true);
    expect(
      j2.idempotent,
      'event_id différent → PAS idempotent même si payload identique',
    ).not.toBe(true);

    // 2 rows distinctes
    const count = selectScalar(
      `SELECT count(*) FROM hub_app.stripe_events WHERE event_id IN ('${eventId1}', '${eventId2}');`,
    );
    expect(count).toBe('2');
  });
});
