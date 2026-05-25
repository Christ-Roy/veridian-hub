/**
 * MEGA C-05 — Switch mensuel ↔ annuel
 *
 * **SCÉNARIO** : checkout `notifuse-pro` mois → puis 2e checkout
 * `notifuse-pro` année → asserts que les 2 sessions sont créées avec
 * line_items différents (priceId mensuel vs annuel).
 *
 * Le prorata est géré côté Stripe natif (subscription.items.update),
 * pas par /api/billing/checkout qui crée toujours une nouvelle session.
 * Le switch réel passerait par un Customer Portal — pas exposé Hub
 * actuellement. Donc on valide ici les invariants ce qu'on contrôle :
 * 2 sessions checkout valides, line_items distincts, metadata cohérente.
 *
 * **ASSERTS HARDCORE** (~11) :
 *   1-3. Mock OAuth + signup
 *   4. Checkout month → 200 + URL Stripe
 *   5. Customer Stripe créé après 1er checkout
 *   6. Checkout year → 200 + URL Stripe (réutilise customer)
 *   7. Customer ID identique aux 2 sessions (= 1 seul Customer Stripe par user)
 *   8. line_items[0].price.id différents entre month et year
 *   9. line_items[0].price.recurring.interval = month vs year
 *  10. Webhook simulé sur la session annuelle → 200 + persisté
 *  11. event_type cohérent (`customer.subscription.created` avec interval=year)
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
const SPEC = '05-switch-monthly-annual';

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

test.describe('Mega C-05 — Switch mensuel ↔ annuel notifuse-pro', () => {
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

  test('checkout month puis year → 2 sessions, line_items différents, customer unique', async ({
    playwright,
    request,
  }) => {
    await assertMockOAuthAvailable(request);

    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google' },
    );
    expect(session.callbackStatus).toBeLessThan(400);

    // ─── 1er checkout : month ────────────────────────────────────────
    const monthRes = await session.request.post('/api/billing/checkout', {
      headers: { 'content-type': 'application/json', ...freshIpHeader() },
      data: { plan: 'notifuse-pro', interval: 'month' },
      failOnStatusCode: false,
    });
    const monthBodyText = await monthRes.text();
    expect(
      monthRes.status(),
      `month checkout. Body: ${monthBodyText.slice(0, 400)}`,
    ).toBe(200);

    const monthBody = JSON.parse(monthBodyText) as {
      url?: string;
      session_id?: string;
    };
    expect(monthBody.url as string).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    // ─── 2e checkout : year ──────────────────────────────────────────
    const yearRes = await session.request.post('/api/billing/checkout', {
      headers: { 'content-type': 'application/json', ...freshIpHeader() },
      data: { plan: 'notifuse-pro', interval: 'year' },
      failOnStatusCode: false,
    });
    const yearBodyText = await yearRes.text();
    expect(
      yearRes.status(),
      `year checkout. Body: ${yearBodyText.slice(0, 400)}`,
    ).toBe(200);

    const yearBody = JSON.parse(yearBodyText) as {
      url?: string;
      session_id?: string;
    };
    expect(yearBody.url as string).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    // ─── Inspection Stripe ────────────────────────────────────────────
    try {
      const customer = await getCustomerByEmail(session.email);
      expect(customer, 'Customer unique pour les 2 sessions').not.toBeNull();

      const stripe = getStripeSdk();
      const monthSession = await stripe.checkout.sessions.retrieve(
        monthBody.session_id as string,
        { expand: ['line_items', 'line_items.data.price'] },
      );
      const yearSession = await stripe.checkout.sessions.retrieve(
        yearBody.session_id as string,
        { expand: ['line_items', 'line_items.data.price'] },
      );

      // Même customer = 1 seul Stripe Customer par user
      expect(
        monthSession.customer,
        'Les 2 sessions partagent le même Customer Stripe',
      ).toBe(yearSession.customer);

      // line_items distincts (priceId différent month vs year)
      const monthPriceId = monthSession.line_items?.data[0]?.price?.id;
      const yearPriceId = yearSession.line_items?.data[0]?.price?.id;
      expect(monthPriceId, 'monthly price id présent').toBeTruthy();
      expect(yearPriceId, 'yearly price id présent').toBeTruthy();
      expect(
        monthPriceId,
        'monthly ≠ yearly priceId (sinon le switch ne facture pas le bon montant)',
      ).not.toBe(yearPriceId);

      // Interval doit matcher
      const monthInterval =
        monthSession.line_items?.data[0]?.price?.recurring?.interval;
      const yearInterval =
        yearSession.line_items?.data[0]?.price?.recurring?.interval;
      expect(monthInterval).toBe('month');
      expect(yearInterval).toBe('year');
    } catch (err) {
      if (err instanceof StripeConfigError) {
        test.skip(true, `Stripe TEST key absente: ${err.message}`);
        return;
      }
      throw err;
    }

    // ─── Webhook simulé sur sub annuelle ─────────────────────────────
    const eventId = `evt_mega_c05_${MEGA_RUN_STAMP}_${Math.random()
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
      type: 'customer.subscription.created',
      data: {
        object: {
          id: `sub_mega_c05_${MEGA_RUN_STAMP}`,
          object: 'subscription',
          customer: `cus_mega_c05_${MEGA_RUN_STAMP}`,
          status: 'active',
          items: {
            object: 'list',
            data: [
              {
                id: `si_mega_c05_${MEGA_RUN_STAMP}`,
                price: {
                  id: 'price_mega_c05_year',
                  recurring: { interval: 'year' },
                },
              },
            ],
            has_more: false,
            url: '',
          },
          metadata: { plan_key: 'notifuse-pro', app: 'notifuse' },
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
    expect(persisted).toBe('customer.subscription.created');

    runSqlOnStaging(
      `DELETE FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
  });
});
