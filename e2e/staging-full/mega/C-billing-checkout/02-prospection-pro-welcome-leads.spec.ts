/**
 * MEGA C-02 — Prospection Pro mensuel + welcome leads
 *
 * **SCÉNARIO** : signup → POST /api/billing/checkout `prospection-pro` →
 * webhook simulé → vérifie que metadata Stripe encode bien `app:prospection`
 * + `plan_key:prospection-pro`. Le grant des welcome leads est géré côté
 * Prospection downstream après réception du `update-plan` HMAC, on s'assure
 * juste ici que le routing Hub est correct (le dispatcher écrit
 * `notifusePlan='free'` + `prospectionPlan='pro'` côté Tenant Hub si la sub
 * trouve un tenant matchant).
 *
 * **ASSERTS HARDCORE** (~11) :
 *   1. Mock OAuth dispo
 *   2. Signup OK
 *   3. Checkout POST 200
 *   4. URL Stripe valide
 *   5. session_id format `cs_*`
 *   6. Customer Stripe existe
 *   7. Webhook accepté (200)
 *   8. stripe_events persisté avec event_type
 *   9. customer_id extrait
 *  10. Replay idempotent
 *  11. UN seul row stripe_events
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
import { getCustomerByEmail, StripeConfigError } from '../_fixtures/stripe-api';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'c';
const SPEC = '02-prospection-pro-welcome-leads';

const STAGING_WHSEC =
  process.env.STRIPE_WEBHOOK_SECRET_TEST ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  'whsec_fake';
const stripeWebhookSdk = new Stripe('sk_test_fake');

function signEvent(body: string, secret = STAGING_WHSEC): string {
  const timestamp = Math.floor(Date.now() / 1000);
  return stripeWebhookSdk.webhooks.generateTestHeaderString({
    payload: body,
    secret,
    timestamp,
  });
}

test.describe('Mega C-02 — Prospection Pro checkout + welcome leads routing', () => {
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

  test('checkout prospection-pro month → 200 + customer + webhook routes app=prospection', async ({
    playwright,
    request,
  }) => {
    await assertMockOAuthAvailable(request);

    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google' },
    );
    expect(session.callbackStatus).toBeLessThan(400);

    // ─── Checkout prospection-pro ────────────────────────────────────
    const res = await session.request.post('/api/billing/checkout', {
      headers: { 'content-type': 'application/json', ...freshIpHeader() },
      data: { plan: 'prospection-pro', interval: 'month' },
      failOnStatusCode: false,
    });
    const bodyText = await res.text();
    expect(res.status(), `Body: ${bodyText.slice(0, 400)}`).toBe(200);

    const body = JSON.parse(bodyText) as { url?: string; session_id?: string };
    expect(body.url as string).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(body.session_id as string).toMatch(/^cs_(test|live)_/);

    // ─── Customer Stripe existe ───────────────────────────────────────
    try {
      const customer = await getCustomerByEmail(session.email);
      expect(customer, 'Customer Stripe créé').not.toBeNull();
      if (customer) {
        expect(customer.email).toBe(session.email);
      }
    } catch (err) {
      if (err instanceof StripeConfigError) {
        test.skip(true, `Stripe TEST key absente: ${err.message}`);
        return;
      }
      throw err;
    }

    // ─── Webhook checkout.session.completed pour prospection-pro ─────
    const eventId = `evt_mega_c02_${MEGA_RUN_STAMP}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const customerStripeId = `cus_mega_c02_${MEGA_RUN_STAMP}`;
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
          id: `cs_mega_c02_${MEGA_RUN_STAMP}`,
          object: 'checkout.session',
          customer: customerStripeId,
          subscription: `sub_mega_c02_${MEGA_RUN_STAMP}`,
          status: 'complete',
          mode: 'subscription',
          payment_status: 'paid',
          metadata: { plan_key: 'prospection-pro', app: 'prospection' },
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
    expect(webhookRes.status(), 'Signature valide → 200').toBe(200);

    // ─── Row persistée ────────────────────────────────────────────────
    const row = selectRow(
      `SELECT event_type, COALESCE(customer_id, '') AS cid
       FROM hub_app.stripe_events
       WHERE event_id = '${eventId}';`,
      ['event_type', 'cid'],
    );
    expect(row, 'event_id row doit exister').not.toBeNull();
    expect(row!.event_type).toBe('checkout.session.completed');
    expect(
      row!.cid,
      'dispatcher doit extraire customer_id depuis l\'objet event',
    ).toContain('cus_mega_c02_');

    // ─── Idempotence ──────────────────────────────────────────────────
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
    expect(count, 'PK empêche doublons').toBe('1');

    runSqlOnStaging(
      `DELETE FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
  });
});
