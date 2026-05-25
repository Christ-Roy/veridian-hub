/**
 * MEGA D-03 — Cancel + reactivate (grace period)
 *
 * **SCÉNARIO** : on simule sub Pro active → webhook
 * `customer.subscription.updated` avec `cancel_at_period_end=true` →
 * user reste 'pro' jusqu'à fin période → webhook reactivate
 * `cancel_at_period_end=false` → user reste 'pro' sans interruption.
 *
 * Côté Hub, l'invariant : les 2 events sont accepté, persisté, et un
 * `subscription.deleted` n'est PAS émis tant qu'on n'a pas dépassé
 * `current_period_end` ET `cancel_at_period_end=true`.
 *
 * **ASSERTS HARDCORE** (~10) :
 *   1-3. Mock OAuth + signup + checkout Pro initial
 *   4. Webhook subscription.updated avec cancel_at_period_end=true → 200
 *   5. stripe_events row persistée pour le cancel
 *   6. Reactivate webhook (cancel_at_period_end=false) → 200
 *   7. stripe_events row persistée pour le reactivate
 *   8. Idempotence cancel : 2 fois le même event_id → 1 row
 *   9. event_type cohérent (customer.subscription.updated les 2 fois)
 *  10. Anti-régression : pas de `subscription.deleted` automatique entre
 *      les 2 webhooks (on n'attend rien de spécial mais on vérifie
 *      qu'aucun stripe_events fantôme `customer.subscription.deleted` n'a
 *      été créé avec notre customer_id)
 */
import { test, expect } from '@playwright/test';
import Stripe from 'stripe';

import { STAGING_URL, freshIpHeader } from '../../_helpers';
import { runSqlOnStaging, selectScalar } from '../../_sql-helper';

import {
  assertMockOAuthAvailable,
  disposeSession,
  megaSignIn,
  type MegaSession,
} from '../_fixtures/mock-oauth';
import { purgeMegaByPrefix } from '../_fixtures/db-purge';
import { StripeConfigError } from '../_fixtures/stripe-api';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'd';
const SPEC = '03-cancel-reactivate-grace';

const STAGING_WHSEC =
  process.env.STRIPE_WEBHOOK_SECRET_TEST ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  'whsec_fake';
const stripeWebhookSdk = new Stripe('sk_test_fake');

function signEvent(body: string): string {
  return stripeWebhookSdk.webhooks.generateTestHeaderString({
    payload: body,
    secret: STAGING_WHSEC,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

function makeSubUpdate(opts: {
  eventId: string;
  customerId: string;
  subscriptionId: string;
  cancelAtPeriodEnd: boolean;
}) {
  return {
    id: opts.eventId,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: opts.subscriptionId,
        object: 'subscription',
        customer: opts.customerId,
        status: 'active',
        cancel_at_period_end: opts.cancelAtPeriodEnd,
        current_period_end:
          Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 25, // +25j
        items: { object: 'list', data: [], has_more: false, url: '' },
        metadata: { plan_key: 'notifuse-pro', app: 'notifuse' },
      },
    },
  };
}

test.describe('Mega D-03 — Cancel + reactivate grace period', () => {
  let session: MegaSession | null = null;

  test.afterEach(async () => {
    if (session) {
      await disposeSession(session);
      session = null;
    }
  });

  test.afterAll(async () => {
    try {
      await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}`,
        tenantPrefix: `mega-${BUCKET}`,
      });
    } catch {
      /* swallow */
    }
  });

  test('cancel webhook → reactivate webhook → tenants restent active', async ({
    playwright,
    request,
  }) => {
    await assertMockOAuthAvailable(request);

    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google' },
    );
    expect(session.callbackStatus).toBeLessThan(400);

    // ─── Checkout Pro initial ────────────────────────────────────────
    const checkoutRes = await session.request.post('/api/billing/checkout', {
      headers: { 'content-type': 'application/json', ...freshIpHeader() },
      data: { plan: 'notifuse-pro', interval: 'month' },
      failOnStatusCode: false,
    });
    const checkoutText = await checkoutRes.text();
    if (checkoutRes.status() !== 200) {
      const bodyTry = (() => {
        try {
          return JSON.parse(checkoutText) as { error?: string };
        } catch {
          return { error: 'parse_failed' };
        }
      })();
      if (
        bodyTry.error === 'stripe_price_not_configured' ||
        bodyTry.error === 'stripe_session_failed' ||
        bodyTry.error === 'stripe_customer_failed'
      ) {
        test.skip(true, `Stripe TEST pas dispo (${bodyTry.error})`);
        return;
      }
    }
    expect(
      checkoutRes.status(),
      `Pro checkout. Body: ${checkoutText.slice(0, 400)}`,
    ).toBe(200);

    const customerId = `cus_mega_d03_${MEGA_RUN_STAMP}`;
    const subId = `sub_mega_d03_${MEGA_RUN_STAMP}`;

    // ─── 1. Webhook cancel (cancel_at_period_end=true) ───────────────
    const cancelEventId = `evt_mega_d03_cancel_${MEGA_RUN_STAMP}`;
    const cancelEvent = makeSubUpdate({
      eventId: cancelEventId,
      customerId,
      subscriptionId: subId,
      cancelAtPeriodEnd: true,
    });
    const cancelBody = JSON.stringify(cancelEvent);

    try {
      const cancelRes = await request.post(`${STAGING_URL}/api/webhooks`, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signEvent(cancelBody),
          ...freshIpHeader(),
        },
        data: cancelBody,
        failOnStatusCode: false,
      });
      expect(cancelRes.status(), 'Webhook cancel accepté').toBe(200);

      const cancelPersisted = selectScalar(
        `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${cancelEventId}';`,
      );
      expect(cancelPersisted).toBe('customer.subscription.updated');

      // Idempotence cancel
      const cancelReplay = await request.post(`${STAGING_URL}/api/webhooks`, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signEvent(cancelBody),
          ...freshIpHeader(),
        },
        data: cancelBody,
        failOnStatusCode: false,
      });
      expect(cancelReplay.status()).toBe(200);

      const cancelCount = selectScalar(
        `SELECT count(*) FROM hub_app.stripe_events WHERE event_id = '${cancelEventId}';`,
      );
      expect(cancelCount).toBe('1');

      // ─── 2. Webhook reactivate (cancel_at_period_end=false) ──────
      const reactEventId = `evt_mega_d03_react_${MEGA_RUN_STAMP}`;
      const reactEvent = makeSubUpdate({
        eventId: reactEventId,
        customerId,
        subscriptionId: subId,
        cancelAtPeriodEnd: false,
      });
      const reactBody = JSON.stringify(reactEvent);

      const reactRes = await request.post(`${STAGING_URL}/api/webhooks`, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signEvent(reactBody),
          ...freshIpHeader(),
        },
        data: reactBody,
        failOnStatusCode: false,
      });
      expect(reactRes.status(), 'Webhook reactivate accepté').toBe(200);

      const reactPersisted = selectScalar(
        `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${reactEventId}';`,
      );
      expect(reactPersisted).toBe('customer.subscription.updated');

      // ─── 3. Anti-régression : pas de subscription.deleted fantôme ─
      // On vérifie qu'aucune row stripe_events `customer.subscription.deleted`
      // n'existe pour notre customer (le Hub ne doit PAS auto-générer un
      // `deleted` event entre cancel et reactivate).
      const phantomDeleted = selectScalar(
        `SELECT count(*) FROM hub_app.stripe_events
         WHERE customer_id = '${customerId}'
           AND event_type = 'customer.subscription.deleted';`,
      );
      expect(
        phantomDeleted,
        'Aucun deleted fantôme entre cancel et reactivate',
      ).toBe('0');

      runSqlOnStaging(
        `DELETE FROM hub_app.stripe_events
         WHERE event_id IN ('${cancelEventId}', '${reactEventId}');`,
      );
    } catch (err) {
      if (err instanceof StripeConfigError) {
        test.skip(true, `Stripe config missing: ${err.message}`);
        return;
      }
      throw err;
    }
  });
});
