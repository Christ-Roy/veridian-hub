/**
 * MEGA D-01 — Upgrade Pro → Business via webhook
 *
 * **SCÉNARIO** : on simule un user sub `notifuse-pro` actif → on envoie
 * un webhook `customer.subscription.updated` avec metadata pointant vers
 * `notifuse-business` → asserts que le webhook est accepté et persisté.
 *
 * Le prorata est géré côté Stripe natif (pas un calcul Hub). Le delta
 * welcome leads est géré côté Prospection downstream (le HMAC `update-plan`
 * porte le `target_plan`). Côté Hub on valide :
 *   - Webhook reçu, signature OK, persisté pour forensics
 *   - Idempotence : 2 events `updated` avec MÊME event.id → 1 seule row
 *   - Le router event-type `customer.subscription.updated` → handler correct
 *
 * **ASSERTS HARDCORE** (~10) :
 *   1-3. Mock OAuth + signup + checkout Pro initial (création customer)
 *   4. Webhook subscription.updated → 200
 *   5. stripe_events row persistée
 *   6. event_type cohérent
 *   7. customer_id extrait
 *   8. Replay même event.id → 200 idempotent
 *   9. Count après replay === 1
 *  10. Anti-fail : 2e webhook avec NOUVEL event_id mais MÊME sub →
 *      accepté (chaque event business est unique, même si la sub a
 *      déjà été update)
 */
import { test, expect } from '@playwright/test';
import Stripe from 'stripe';

import { STAGING_URL, freshIpHeader } from '../../_helpers';
import { runSqlOnStaging, selectScalar, selectRow } from '../../_sql-helper';

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
const SPEC = '01-upgrade-pro-to-business';

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

function makeSubscriptionUpdatedEvent(opts: {
  eventId: string;
  customerId: string;
  subscriptionId: string;
  planKey: string;
  app: string;
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
        items: { object: 'list', data: [], has_more: false, url: '' },
        metadata: { plan_key: opts.planKey, app: opts.app },
      },
    },
  };
}

test.describe('Mega D-01 — Upgrade Pro → Business webhook', () => {
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
        emailPrefix: `e2e-mega-${BUCKET}-${SPEC}`,
        tenantPrefix: `mega-${BUCKET}-${MEGA_RUN_STAMP}`,
      });
    } catch {
      /* swallow */
    }
  });

  test('subscription.updated notifuse-pro → notifuse-business → 200 persisté idempotent', async ({
    playwright,
    request,
  }) => {
    await assertMockOAuthAvailable(request);

    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google' },
    );
    expect(session.callbackStatus).toBeLessThan(400);

    // ─── Checkout Pro initial (crée Stripe customer côté Hub) ────────
    const checkoutRes = await session.request.post('/api/billing/checkout', {
      headers: { 'content-type': 'application/json', ...freshIpHeader() },
      data: { plan: 'notifuse-pro', interval: 'month' },
      failOnStatusCode: false,
    });
    const checkoutText = await checkoutRes.text();
    if (checkoutRes.status() !== 200) {
      // Si Stripe TEST pas configuré sur staging → skip (couvert par C-01)
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
        test.skip(
          true,
          `Stripe TEST pas dispo (${bodyTry.error}) — D-01 dépend de C-01 pour le prerequis customer`,
        );
        return;
      }
    }
    expect(
      checkoutRes.status(),
      `Pro initial checkout. Body: ${checkoutText.slice(0, 400)}`,
    ).toBe(200);

    // ─── Webhook subscription.updated business ───────────────────────
    const customerId = `cus_mega_d01_${MEGA_RUN_STAMP}`;
    const subId = `sub_mega_d01_${MEGA_RUN_STAMP}`;
    const eventId = `evt_mega_d01_${MEGA_RUN_STAMP}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const event = makeSubscriptionUpdatedEvent({
      eventId,
      customerId,
      subscriptionId: subId,
      planKey: 'notifuse-business',
      app: 'notifuse',
    });
    const body = JSON.stringify(event);

    try {
      const res = await request.post(`${STAGING_URL}/api/webhooks`, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signEvent(body),
          ...freshIpHeader(),
        },
        data: body,
        failOnStatusCode: false,
      });
      expect(res.status(), 'subscription.updated signature OK → 200').toBe(200);

      const row = selectRow(
        `SELECT event_type, COALESCE(customer_id, '') AS cid
         FROM hub_app.stripe_events
         WHERE event_id = '${eventId}';`,
        ['event_type', 'cid'],
      );
      expect(row, 'row persistée pour forensics').not.toBeNull();
      expect(row!.event_type).toBe('customer.subscription.updated');
      expect(row!.cid).toContain('cus_mega_d01_');

      // ─── Replay même event.id → idempotent ────────────────────────
      const replay = await request.post(`${STAGING_URL}/api/webhooks`, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signEvent(body),
          ...freshIpHeader(),
        },
        data: body,
        failOnStatusCode: false,
      });
      expect(replay.status()).toBe(200);

      const count = selectScalar(
        `SELECT count(*) FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
      );
      expect(count, 'PK event_id empêche doublons').toBe('1');

      // ─── 2e webhook NOUVEL event.id sur la MÊME sub → accepté ─────
      const eventId2 = `${eventId}-bis`;
      const event2 = makeSubscriptionUpdatedEvent({
        eventId: eventId2,
        customerId,
        subscriptionId: subId,
        planKey: 'notifuse-business',
        app: 'notifuse',
      });
      const body2 = JSON.stringify(event2);
      const res2 = await request.post(`${STAGING_URL}/api/webhooks`, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signEvent(body2),
          ...freshIpHeader(),
        },
        data: body2,
        failOnStatusCode: false,
      });
      expect(
        res2.status(),
        '2e webhook avec event_id différent → accepté (chaque event business unique)',
      ).toBe(200);

      const persistedType2 = selectScalar(
        `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${eventId2}';`,
      );
      expect(persistedType2).toBe('customer.subscription.updated');

      runSqlOnStaging(
        `DELETE FROM hub_app.stripe_events WHERE event_id IN ('${eventId}', '${eventId2}');`,
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
