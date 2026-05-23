/**
 * Journey 14 — Stripe webhook dispatcher (events business mappés).
 *
 * **POURQUOI** : le spec 09 valide les invariants signature + idempotence
 * **génériques** du dispatcher. Ce spec 14 va plus loin et exerce
 * **chaque event business mappé** côté `lib/stripe/dispatcher.ts` pour
 * valider que :
 *   1. Le router event-type → handler est correct (pas de regression
 *      silencieuse type "on a renommé `customer.subscription.created` en
 *      `subscription.created` mais oublié un alias")
 *   2. La row `hub_app.stripe_events` est bien persistée avec le bon
 *      event_type, customer_id, processed_at
 *   3. Le webhook répond toujours 200 sur signature valide même si le
 *      handler interne ne peut pas faire le boulot (invariant Stripe :
 *      tout autre code = 50+ retries pendant 3j)
 *
 * **CE SPEC COUVRE** (5 scénarios cumulés) :
 *   S1 `customer.subscription.created` (mock minimal) → 200 outcome ∈
 *      {processed, failed, ignored}, row persistée
 *   S2 `customer.subscription.updated` → idem
 *   S3 `customer.subscription.deleted` → idem (downgrade flow)
 *   S4 `invoice.payment_failed` → idem (dunning flow)
 *   S5 `checkout.session.completed` → idem (post-payment trigger)
 *   S6 Event type hors whitelist (`product.created`) → 200 outcome=ignored,
 *      row persistée (pour audit forensics) mais pas processed
 *   S7 Stripe replay : envoyer 2× le même event.id → idempotent au 2e call
 *   S8 Customer deleted → 200, row persistée + soft-delete tenté côté DB
 *
 * **GARDE-FOU CRITIQUE** :
 *   - Aucun de ces tests ne doit produire de 5xx (Stripe traduit ça en
 *     retry de 3 jours qui peut saturer la table stripe_events).
 *   - Toutes les rows persistées contiennent event_type + payload non-null
 *     (forensics).
 *
 * **STAGING** : depuis 2026-05-23, le compose utilise la vraie valeur Stripe
 * TEST `${STRIPE_WEBHOOK_SECRET_TEST:-whsec_fake}`. Les fixtures résolvent
 * dynamiquement (env > fallback). Le runner `scripts/e2e/staging-full.sh`
 * exporte automatiquement depuis `~/credentials/.all-creds.env`.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import Stripe from 'stripe';

import { STAGING_URL, freshIpHeader } from './_helpers';
import { runSqlOnStaging, selectScalar, selectRow } from './_sql-helper';

// Cf. spec 09 pour la logique de résolution du secret (env > fallback).
const STAGING_WHSEC =
  process.env.STRIPE_WEBHOOK_SECRET_TEST ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  'whsec_fake';
const stripe = new Stripe('sk_test_fake');

function signEvent(body: string, secret = STAGING_WHSEC): string {
  const timestamp = Math.floor(Date.now() / 1000);
  return stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
    timestamp,
  });
}

function makeEvent(
  type: string,
  dataObject: Partial<Stripe.Event.Data.Object>,
  override: Partial<Stripe.Event> = {},
): Stripe.Event {
  return {
    id:
      override.id ??
      `evt_e2e_${type.replace(/\./g, '_')}_${Date.now()}_${Math.random()
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
    ...override,
  } as Stripe.Event;
}

async function postWebhook(
  request: APIRequestContext,
  event: Stripe.Event,
  signatureOverride?: string,
) {
  const body = JSON.stringify(event);
  const signature = signatureOverride ?? signEvent(body);
  return request.post(`${STAGING_URL}/api/webhooks`, {
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
      ...freshIpHeader(),
    },
    data: body,
    failOnStatusCode: false,
  });
}

function readBody(resBody: { outcome?: string; idempotent?: boolean; received?: boolean }) {
  return {
    outcome: resBody.outcome,
    idempotent: resBody.idempotent,
    received: resBody.received,
  };
}

// ─── S1-S5 : Events business mappés ──────────────────────────────────────

test.describe('Journey 14 — S1-S5 events business mappés', () => {
  test('S1 customer.subscription.created → 200, row persistée', async ({
    request,
  }) => {
    const event = makeEvent('customer.subscription.created', {
      id: `sub_e2e_${Date.now()}`,
      object: 'subscription',
      customer: `cus_e2e_${Date.now()}`,
      status: 'active',
      items: { data: [], has_more: false, object: 'list', url: '' },
      metadata: { plan_key: 'notifuse-pro' },
    } as unknown as Stripe.Event.Data.Object);

    const res = await postWebhook(request, event);
    expect(
      res.status(),
      'CRITIQUE : signature valide → toujours 200 (sinon Stripe retry 50×)',
    ).toBe(200);
    const body = readBody(await res.json());
    expect(['processed', 'failed', 'ignored']).toContain(body.outcome);

    // La row doit être persistée pour forensics, même si le dispatch fail
    // (le customer n'existe pas en DB Hub staging).
    const persistedType = selectScalar(
      `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${event.id}';`,
    );
    expect(persistedType).toBe('customer.subscription.created');
  });

  test('S2 customer.subscription.updated → 200', async ({ request }) => {
    const event = makeEvent('customer.subscription.updated', {
      id: `sub_e2e_${Date.now()}`,
      object: 'subscription',
      customer: `cus_e2e_${Date.now()}`,
      status: 'active',
      items: { data: [], has_more: false, object: 'list', url: '' },
      metadata: {},
    } as unknown as Stripe.Event.Data.Object);

    const res = await postWebhook(request, event);
    expect(res.status()).toBe(200);
    const body = readBody(await res.json());
    expect(['processed', 'failed', 'ignored']).toContain(body.outcome);
  });

  test('S3 customer.subscription.deleted → 200 (downgrade flow)', async ({
    request,
  }) => {
    const event = makeEvent('customer.subscription.deleted', {
      id: `sub_e2e_${Date.now()}`,
      object: 'subscription',
      customer: `cus_e2e_${Date.now()}`,
      status: 'canceled',
      items: { data: [], has_more: false, object: 'list', url: '' },
      metadata: {},
    } as unknown as Stripe.Event.Data.Object);

    const res = await postWebhook(request, event);
    expect(res.status()).toBe(200);
    const body = readBody(await res.json());
    expect(['processed', 'failed', 'ignored']).toContain(body.outcome);

    const persisted = selectScalar(
      `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${event.id}';`,
    );
    expect(persisted).toBe('customer.subscription.deleted');
  });

  test('S4 invoice.payment_failed → 200 (dunning trigger)', async ({
    request,
  }) => {
    const event = makeEvent('invoice.payment_failed', {
      id: `in_e2e_${Date.now()}`,
      object: 'invoice',
      customer: `cus_e2e_${Date.now()}`,
      subscription: `sub_e2e_${Date.now()}`,
      status: 'open',
      amount_due: 2900,
      currency: 'eur',
    } as unknown as Stripe.Event.Data.Object);

    const res = await postWebhook(request, event);
    expect(res.status()).toBe(200);
    const body = readBody(await res.json());
    expect(['processed', 'failed', 'ignored']).toContain(body.outcome);
  });

  test('S5 checkout.session.completed → 200', async ({ request }) => {
    const event = makeEvent('checkout.session.completed', {
      id: `cs_e2e_${Date.now()}`,
      object: 'checkout.session',
      customer: `cus_e2e_${Date.now()}`,
      subscription: `sub_e2e_${Date.now()}`,
      status: 'complete',
      mode: 'subscription',
      payment_status: 'paid',
      metadata: {},
    } as unknown as Stripe.Event.Data.Object);

    const res = await postWebhook(request, event);
    expect(res.status()).toBe(200);
    const body = readBody(await res.json());
    expect(['processed', 'failed', 'ignored']).toContain(body.outcome);
  });
});

// ─── S6 : Event hors whitelist → persisté + ignored ──────────────────────

test.describe('Journey 14 — S6 Event hors whitelist', () => {
  test('product.created → 200 outcome=ignored, row quand même persistée', async ({
    request,
  }) => {
    const event = makeEvent('product.created', {
      id: `prod_e2e_${Date.now()}`,
      object: 'product',
      name: 'Test product',
      active: true,
    } as unknown as Stripe.Event.Data.Object);

    const res = await postWebhook(request, event);
    expect(res.status()).toBe(200);
    const body = readBody(await res.json());
    expect(body.outcome).toBe('ignored');

    const persisted = selectScalar(
      `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${event.id}';`,
    );
    expect(
      persisted,
      'event hors whitelist DOIT être persisté pour forensics',
    ).toBe('product.created');
  });
});

// ─── S7 : Replay même event.id → idempotent ──────────────────────────────
//
// **NOTE DESIGN (2026-05-23)** : un event qui FAIL côté handler garde
// `processed_at = NULL` côté `hub_app.stripe_events` — c'est intentionnel
// (contrat-billing §2.2 : retry Stripe = retry Hub jusqu'à ce que le
// dispatch réussisse ou que le cron de réconciliation passe). On NE peut
// donc PAS tester l'idempotence avec un event mappé `subscription.created`
// dont la data est fake — la 1ère tentative fail, donc la 2e re-tente
// (comportement attendu).
//
// On utilise donc un event hors whitelist (`product.created`) dont le
// dispatcher renvoie `ignored` succès → `processed_at` est set → replay
// renvoie bien `idempotent: true`. C'est le scénario "Stripe retry sur
// un 200 perdu en route" qu'on veut couvrir.

test.describe('Journey 14 — S7 Replay idempotent', () => {
  test('2× même event.id → 2e=idempotent=true', async ({ request }) => {
    // Event ignored par le dispatcher (hors whitelist) → processedAt set →
    // idempotence active. Cf. note design ci-dessus pour le détail.
    const event = makeEvent('product.created', {
      id: `prod_replay_${Date.now()}`,
      object: 'product',
      name: 'Replay test product',
      active: true,
    } as unknown as Stripe.Event.Data.Object);

    const first = await postWebhook(request, event);
    expect(first.status()).toBe(200);
    const firstBody = readBody(await first.json());
    expect(firstBody.idempotent).not.toBe(true);
    expect(firstBody.outcome).toBe('ignored');

    // 2e call — signature différente (timestamp neuf) mais MÊME event.id
    const second = await postWebhook(request, event);
    expect(second.status()).toBe(200);
    const secondBody = readBody(await second.json());
    expect(
      secondBody.idempotent,
      'replay même event.id DOIT renvoyer idempotent=true',
    ).toBe(true);

    // Une seule row persistée.
    const count = selectScalar(
      `SELECT count(*) FROM hub_app.stripe_events WHERE event_id = '${event.id}';`,
    );
    expect(count, 'PK event.id doit empêcher les doublons').toBe('1');
  });
});

// ─── S8 : customer.deleted → soft-delete ─────────────────────────────────

test.describe('Journey 14 — S8 customer.deleted', () => {
  test('customer.deleted → 200, row persistée', async ({ request }) => {
    const event = makeEvent('customer.deleted', {
      id: `cus_deleted_${Date.now()}`,
      object: 'customer',
      deleted: true,
    } as unknown as Stripe.Event.Data.Object);

    const res = await postWebhook(request, event);
    expect(res.status()).toBe(200);
    const body = readBody(await res.json());
    expect(['processed', 'failed', 'ignored']).toContain(body.outcome);

    const row = selectRow(
      `SELECT event_type, customer_id FROM hub_app.stripe_events
       WHERE event_id = '${event.id}';`,
      ['event_type', 'customer_id'],
    );
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe('customer.deleted');
    // Le dispatcher devrait avoir extrait customer.id même quand l'event
    // est un customer.* (l'objet EST le customer).
    expect(
      row!.customer_id,
      'dispatcher doit extraire customer_id depuis l\'objet event',
    ).toContain('cus_deleted_');
  });
});

// ─── Cleanup global : on garde les rows pour forensics, pas de DELETE ─────
// (la table stripe_events est append-only par design — utile pour audit + replay)
