/**
 * MEGA C-04 — Bundle Veridian Business (149€)
 *
 * **SCÉNARIO** : checkout `veridian-business` → assert le bundle Business
 * passe (Notifuse Business + Prospection Business unlockés via metadata
 * `app=bundle`).
 *
 * **ASSERTS HARDCORE** (~11) :
 *   1-5. Mock OAuth + signup + checkout 200 + URL Stripe + session_id
 *   6. Customer Stripe créé
 *   7. line_items.length === 1 (1 sub Business)
 *   8. Webhook simulé business → 200
 *   9. stripe_events persisté
 *  10. Idempotence replay
 *  11. PAS de fail-cascade : un 2e checkout sur le même user pour
 *      `veridian-pro` (downgrade volontaire) reste 200 (Stripe gère le
 *      switch côté Customer existant).
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
import {
  getCustomerByEmail,
  getStripeSdk,
  StripeConfigError,
} from '../_fixtures/stripe-api';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'c';
const SPEC = '04-bundle-veridian-business';

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

test.describe('Mega C-04 — Bundle Veridian Business 149€', () => {
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

  test('checkout veridian-business → 200 + customer + webhook + 2e checkout switch OK', async ({
    playwright,
    request,
  }) => {
    await assertMockOAuthAvailable(request);

    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google' },
    );
    expect(session.callbackStatus).toBeLessThan(400);

    // ─── Checkout veridian-business ──────────────────────────────────
    const res = await session.request.post('/api/billing/checkout', {
      headers: { 'content-type': 'application/json', ...freshIpHeader() },
      data: { plan: 'veridian-business', interval: 'month' },
      failOnStatusCode: false,
    });
    const bodyText = await res.text();
    expect(res.status(), `Body: ${bodyText.slice(0, 400)}`).toBe(200);

    const body = JSON.parse(bodyText) as { url?: string; session_id?: string };
    expect(body.url as string).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(body.session_id as string).toMatch(/^cs_(test|live)_/);

    try {
      const customer = await getCustomerByEmail(session.email);
      expect(customer, 'Customer Stripe créé').not.toBeNull();

      const stripe = getStripeSdk();
      const checkoutSession = await stripe.checkout.sessions.retrieve(
        body.session_id as string,
        { expand: ['line_items'] },
      );
      expect(
        checkoutSession.line_items?.data.length,
        'Bundle Business = 1 seul line_item',
      ).toBe(1);
    } catch (err) {
      if (err instanceof StripeConfigError) {
        test.skip(true, `Stripe TEST key absente: ${err.message}`);
        return;
      }
      throw err;
    }

    // ─── Webhook bundle business simulé ──────────────────────────────
    const eventId = `evt_mega_c04_${MEGA_RUN_STAMP}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const event = {
      id: eventId,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_mega_c04_${MEGA_RUN_STAMP}`,
          object: 'checkout.session',
          customer: `cus_mega_c04_${MEGA_RUN_STAMP}`,
          subscription: `sub_mega_c04_${MEGA_RUN_STAMP}`,
          status: 'complete',
          mode: 'subscription',
          payment_status: 'paid',
          metadata: { plan_key: 'veridian-business', app: 'bundle' },
        },
      },
    };
    const eventBody = JSON.stringify(event);

    const webhookRes = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signEvent(eventBody),
        ...freshIpHeader(),
      },
      data: eventBody,
      failOnStatusCode: false,
    });
    expect(webhookRes.status()).toBe(200);

    const persisted = selectScalar(
      `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    expect(persisted).toBe('checkout.session.completed');

    // Replay → idempotent
    const replay = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signEvent(eventBody),
        ...freshIpHeader(),
      },
      data: eventBody,
      failOnStatusCode: false,
    });
    expect(replay.status()).toBe(200);

    const count = selectScalar(
      `SELECT count(*) FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    expect(count).toBe('1');

    runSqlOnStaging(
      `DELETE FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );

    // ─── 2e checkout switch volontaire vers veridian-pro ─────────────
    // Stripe Checkout supporte qu'un même customer crée plusieurs
    // sessions (la dernière payée prend le relais via webhook).
    // Le Hub doit accepter sans 5xx (validation route + customer reuse OK).
    const switchRes = await session.request.post('/api/billing/checkout', {
      headers: { 'content-type': 'application/json', ...freshIpHeader() },
      data: { plan: 'veridian-pro', interval: 'month' },
      failOnStatusCode: false,
    });
    const switchBodyText = await switchRes.text();
    expect(
      switchRes.status(),
      `2e checkout switch doit 200. Body: ${switchBodyText.slice(0, 400)}`,
    ).toBe(200);
    const switchBody = JSON.parse(switchBodyText) as { url?: string };
    expect(switchBody.url as string).toMatch(
      /^https:\/\/checkout\.stripe\.com\//,
    );
  });
});
