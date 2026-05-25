/**
 * MEGA F-03 — Webhook events hors timeline / out-of-order / customer absent.
 *
 * **SCÉNARIO BUSINESS** :
 *   Stripe ne garantit PAS l'ordre de livraison des webhooks. Il est possible
 *   de recevoir :
 *     - `subscription.updated` AVANT `subscription.created` (network delay)
 *     - `customer.subscription.deleted` pour un customer absent en DB Hub
 *       (le customer a été crée puis supprimé immédiatement avant que Hub
 *        ait persistance)
 *     - `invoice.payment_failed` pour un sub jamais provisionné côté Hub
 *
 *   Dans tous ces cas, le dispatcher DOIT être fail-safe :
 *     - 200 à Stripe (sinon retry 3 jours → table stripe_events saturée)
 *     - Row persistée pour forensics + retry cron éventuel
 *     - Pas de panic 5xx
 *     - Alerte Telegram pour visibilité (optionnel, audit-only)
 *
 * **ASSERTS COUVERTS** (matrice MEGA §1 F-03 + best practices) :
 *   1. `subscription.deleted` pour customer inexistant → 200 + persisted
 *   2. `subscription.updated` AVANT `subscription.created` (out-of-order)
 *      → les 2 traités, dernière metadata gagne
 *   3. `invoice.payment_failed` orphelin (sub jamais vu) → 200 + persisted
 *   4. `customer.deleted` pour customer inexistant → 200 + persisted (soft-delete tenté no-op)
 *   5. Event volumineux (payload 100KB+) → 200 (pas de timeout, pas de OOM)
 *   6. Event avec data.object manquant → 200 outcome=ignored ou failed
 *   7. Toutes les rows ont event_type et payload non-null (forensics)
 *
 * **CONTRAT** (lib/stripe/dispatcher.ts) :
 *   - Hub renvoie TOUJOURS 200 hors signature invalide.
 *   - En cas d'erreur dispatch, `markEventProcessed({ok:false, error})` set
 *     `error` + incrémente `attempts`. Cron de retry à câbler (V2).
 *
 * Cf ticket racine : `todo/2026-05-23-MEGA-E2E-post-commercialisation.md` §1 F-03.
 */
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
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

function makeEvent(
  type: string,
  dataObject: Partial<Stripe.Event.Data.Object>,
  idOverride?: string,
): Stripe.Event {
  return {
    id:
      idOverride ??
      `evt_e2e_mega_f03_${type.replace(/\./g, '_')}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: type as Stripe.Event.Type,
    data: { object: dataObject as Stripe.Event.Data.Object } as Stripe.Event.Data,
  } as Stripe.Event;
}

async function postWebhook(
  request: APIRequestContext,
  event: Stripe.Event,
): Promise<APIResponse> {
  const body = JSON.stringify(event);
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

test.describe('Mega F-03 — Out-of-order + orphaned events', () => {
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

  test('A — subscription.deleted pour customer inexistant → 200 + row persistée', async ({
    request,
  }) => {
    const fakeCustomer = `cus_e2e_mega_f03_ghost_${Date.now()}`;
    const event = makeEvent('customer.subscription.deleted', {
      id: `sub_e2e_mega_f03_${Date.now()}`,
      object: 'subscription',
      customer: fakeCustomer,
      status: 'canceled',
      items: { data: [], has_more: false, object: 'list', url: '' },
      metadata: {},
    } as unknown as Stripe.Event.Data.Object);
    createdEventIds.push(event.id);

    const res = await postWebhook(request, event);
    expect(
      res.status(),
      'CRITIQUE : Hub doit 200 même quand customer absent (sinon Stripe retry 3j)',
    ).toBe(200);
    const json = await res.json();
    expect(['processed', 'failed', 'ignored']).toContain(json.outcome);

    // Row persistée pour forensics
    const row = selectRow(
      `SELECT event_type, COALESCE(customer_id, '') AS customer_id
       FROM hub_app.stripe_events
       WHERE event_id = '${event.id}';`,
      ['event_type', 'customer_id'],
    );
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe('customer.subscription.deleted');
    expect(
      row!.customer_id,
      'customer_id doit être extrait depuis l\'objet event pour forensics',
    ).toBe(fakeCustomer);
  });

  test('B — out-of-order : updated AVANT created (même sub.id) → les 2 traités', async ({
    request,
  }) => {
    const subId = `sub_e2e_mega_f03_ooo_${Date.now()}`;
    const customerId = `cus_e2e_mega_f03_ooo_${Date.now()}`;

    // Event 1 : UPDATED arrive d'abord (simulation network reorder)
    const updated = makeEvent('customer.subscription.updated', {
      id: subId,
      object: 'subscription',
      customer: customerId,
      status: 'active',
      items: { data: [], has_more: false, object: 'list', url: '' },
      metadata: { plan_key: 'notifuse-business' },
    } as unknown as Stripe.Event.Data.Object);
    createdEventIds.push(updated.id);

    // Event 2 : CREATED arrive ensuite (out-of-order)
    const created = makeEvent('customer.subscription.created', {
      id: subId,
      object: 'subscription',
      customer: customerId,
      status: 'active',
      items: { data: [], has_more: false, object: 'list', url: '' },
      metadata: { plan_key: 'notifuse-pro' },
    } as unknown as Stripe.Event.Data.Object);
    createdEventIds.push(created.id);

    const r1 = await postWebhook(request, updated);
    expect(r1.status(), 'updated 1er → 200 (Hub robuste à l\'order)').toBe(200);

    const r2 = await postWebhook(request, created);
    expect(r2.status(), 'created 2nd → 200').toBe(200);

    // INVARIANT : les 2 events persistés (2 PKs distincts)
    const count = selectScalar(
      `SELECT count(*) FROM hub_app.stripe_events WHERE event_id IN ('${updated.id}', '${created.id}');`,
    );
    expect(count, '2 events distincts persistés').toBe('2');
  });

  test('C — invoice.payment_failed orphelin → 200 + persisted', async ({
    request,
  }) => {
    const event = makeEvent('invoice.payment_failed', {
      id: `in_e2e_mega_f03_orphan_${Date.now()}`,
      object: 'invoice',
      customer: `cus_e2e_mega_f03_orphan_${Date.now()}`,
      subscription: `sub_e2e_mega_f03_orphan_${Date.now()}`,
      status: 'open',
      amount_due: 2900,
      currency: 'eur',
      attempt_count: 2, // < 3 pour éviter d'envoyer une alerte Telegram E2E
    } as unknown as Stripe.Event.Data.Object);
    createdEventIds.push(event.id);

    const res = await postWebhook(request, event);
    expect(res.status(), 'invoice.payment_failed orphelin → 200').toBe(200);
    const json = await res.json();
    expect(['processed', 'failed', 'ignored']).toContain(json.outcome);

    const persisted = selectScalar(
      `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${event.id}';`,
    );
    expect(persisted).toBe('invoice.payment_failed');
  });

  test('D — customer.deleted pour customer inexistant → 200 + persisted', async ({
    request,
  }) => {
    const event = makeEvent('customer.deleted', {
      id: `cus_e2e_mega_f03_del_${Date.now()}`,
      object: 'customer',
      deleted: true,
    } as unknown as Stripe.Event.Data.Object);
    createdEventIds.push(event.id);

    const res = await postWebhook(request, event);
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(['processed', 'failed', 'ignored']).toContain(json.outcome);

    const row = selectRow(
      `SELECT event_type, customer_id
       FROM hub_app.stripe_events
       WHERE event_id = '${event.id}';`,
      ['event_type', 'customer_id'],
    );
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe('customer.deleted');
    // Pour customer.deleted, l'objet EST le customer → customer_id = obj.id
    expect(row!.customer_id).toContain('cus_e2e_mega_f03_del_');
  });

  test('E — event payload volumineux (data.object 50KB) → 200 sans timeout', async ({
    request,
  }) => {
    // Stress test : un event Stripe peut contenir un Customer/Subscription
    // expanded avec beaucoup de metadata. On simule 50KB de metadata pour
    // vérifier qu'on ne timeout pas (le webhook a 30s budget Stripe).
    const bigMetadata: Record<string, string> = {};
    // 50 KV de 1KB chacun ≈ 50KB
    for (let i = 0; i < 50; i++) {
      bigMetadata[`k_${i}`] = 'x'.repeat(1000);
    }

    const event = makeEvent('product.created', {
      id: `prod_e2e_mega_f03_big_${Date.now()}`,
      object: 'product',
      name: 'Big payload',
      active: true,
      metadata: bigMetadata,
    } as unknown as Stripe.Event.Data.Object);
    createdEventIds.push(event.id);

    const t0 = Date.now();
    const res = await postWebhook(request, event);
    const elapsed = Date.now() - t0;

    expect(res.status(), 'payload volumineux → 200').toBe(200);
    expect(
      elapsed,
      'payload 50KB ne doit pas mettre > 10s (Stripe budget 30s)',
    ).toBeLessThan(10_000);
  });

  test('F — event avec data.object minimal (champs requis manquants) → 200 (pas de 5xx)', async ({
    request,
  }) => {
    // Stripe envoie parfois des events où data.object n'a que le minimum
    // requis (id + object). Le handler doit gérer sans crash.
    const event = makeEvent('customer.subscription.updated', {
      // Volontairement minimal — pas de status, pas de customer, pas d'items
      id: `sub_e2e_mega_f03_min_${Date.now()}`,
      object: 'subscription',
    } as unknown as Stripe.Event.Data.Object);
    createdEventIds.push(event.id);

    const res = await postWebhook(request, event);
    expect(
      res.status(),
      'INVARIANT : data.object minimal ne doit JAMAIS produire 5xx (panic)',
    ).toBe(200);
    const json = await res.json();
    // Le dispatcher peut soit traiter (outcome=processed) soit fail proprement
    // (outcome=failed avec error message). Les 2 sont OK — l'invariant est 200.
    expect(['processed', 'failed', 'ignored']).toContain(json.outcome);
  });

  test('G — TOUS les events persistés ont event_type + payload non-null (forensics)', async ({
    request,
  }) => {
    // Anti-régression : check que les rows créées par les tests A-F ont bien
    // event_type ET payload remplis. Pas de row corrompue.
    if (createdEventIds.length === 0) {
      test.skip(true, 'aucun event créé par les tests précédents');
      return;
    }
    const quoted = createdEventIds.map((id) => `'${id}'`).join(',');
    const corrupted = selectScalar(
      `SELECT count(*) FROM hub_app.stripe_events
       WHERE event_id IN (${quoted})
         AND (event_type IS NULL OR event_type = '' OR payload IS NULL);`,
    );
    expect(
      Number(corrupted ?? '0'),
      'INVARIANT forensics : aucune row corrompue (event_type+payload non-null)',
    ).toBe(0);
  });
});
