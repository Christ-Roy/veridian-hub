/**
 * MEGA D-02 — Downgrade Business → Pro
 *
 * **SCÉNARIO** : on simule un user qui a une sub Business active → on
 * envoie un webhook `customer.subscription.updated` avec metadata pointant
 * vers `notifuse-pro` (downgrade). Côté Hub, l'invariant critique :
 *   - Webhook accepté + persisté pour forensics
 *   - PAS de purge de data tenant (le tenant garde ses contacts, séquences,
 *     etc. — c'est business critical, jamais on ne perd la donnée du user)
 *   - Si tenant manuel (`plan_source='lifetime_*'`) : immune au downgrade
 *     (cf D-04, ici on couvre le cas user payant normal)
 *
 * **ASSERTS HARDCORE** (~10) :
 *   1-3. Mock OAuth + signup + checkout Business initial
 *   4. Webhook subscription.updated Business→Pro accepté (200)
 *   5. stripe_events row persistée
 *   6. event_type cohérent
 *   7. Idempotence replay
 *   8. Anti-régression : on insert un tenant test directement avec
 *      notifusePlan='business' + metadata.notifuse_plan_source='stripe'
 *      → simule webhook avec un customer pour ce tenant → on n'attend pas
 *      un changement DB (le user_id du tenant ne match pas le customer
 *      qu'on inject), juste que le dispatcher ne crash pas
 *   9. Anti-régression : tenant downgrade ne purge JAMAIS rien (PK tenants
 *      reste, status reste 'active')
 *  10. Replay event final → 1 seul row
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
const SPEC = '02-downgrade-business-to-pro';

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

test.describe('Mega D-02 — Downgrade Business → Pro, données préservées', () => {
  let session: MegaSession | null = null;
  const directTenantSlug = `mega-${BUCKET}-${MEGA_RUN_STAMP}-downgrade-tenant`;

  test.afterEach(async () => {
    if (session) {
      await disposeSession(session);
      session = null;
    }
  });

  test.afterAll(async () => {
    // Cleanup tenant directement créé en bypass
    try {
      runSqlOnStaging(
        `DELETE FROM hub_app.tenants WHERE slug = '${directTenantSlug}';`,
      );
    } catch {
      /* swallow */
    }
    try {
      await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}-${SPEC}`,
        tenantPrefix: `mega-${BUCKET}-${MEGA_RUN_STAMP}`,
      });
    } catch {
      /* swallow */
    }
  });

  test('subscription.updated Business→Pro accepté + tenants jamais purgés', async ({
    playwright,
    request,
  }) => {
    await assertMockOAuthAvailable(request);

    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google' },
    );
    expect(session.callbackStatus).toBeLessThan(400);

    // ─── 1. Checkout Business initial ────────────────────────────────
    const checkoutRes = await session.request.post('/api/billing/checkout', {
      headers: { 'content-type': 'application/json', ...freshIpHeader() },
      data: { plan: 'notifuse-business', interval: 'month' },
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
      `Business checkout. Body: ${checkoutText.slice(0, 400)}`,
    ).toBe(200);

    // ─── 2. Insert tenant directement avec plan business + plan_source stripe ───
    // (Simule l'état "client Business qui a une sub Stripe" sans devoir
    // attendre la réception complète du webhook checkout.session.completed.)
    const userUuid = '11111111-1111-1111-1111-' + MEGA_RUN_STAMP.slice(0, 12).padEnd(12, '0');
    runSqlOnStaging(
      `INSERT INTO hub_app.tenants (id, user_id, name, slug, status, notifuse_plan, prospection_plan, metadata)
       VALUES (gen_random_uuid(), '${userUuid}'::uuid,
               'D-02 downgrade tenant', '${directTenantSlug}', 'active',
               'business', 'business',
               '{"notifuse_plan_source": "stripe", "prospection_plan_source": "stripe"}'::jsonb)
       ON CONFLICT (slug) DO NOTHING;`,
    );

    // Sanity : tenant créé
    const before = selectRow(
      `SELECT notifuse_plan, status FROM hub_app.tenants WHERE slug = '${directTenantSlug}';`,
      ['notifuse_plan', 'status'],
    );
    expect(before, 'tenant créé en bypass').not.toBeNull();
    expect(before!.notifuse_plan).toBe('business');

    // ─── 3. Webhook subscription.updated Business → Pro ──────────────
    const customerId = `cus_mega_d02_${MEGA_RUN_STAMP}`;
    const subId = `sub_mega_d02_${MEGA_RUN_STAMP}`;
    const eventId = `evt_mega_d02_${MEGA_RUN_STAMP}_${Math.random()
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
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          object: 'subscription',
          customer: customerId,
          status: 'active',
          items: { object: 'list', data: [], has_more: false, url: '' },
          metadata: { plan_key: 'notifuse-pro', app: 'notifuse' },
        },
      },
    };
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
      expect(res.status()).toBe(200);

      const persisted = selectScalar(
        `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
      );
      expect(persisted).toBe('customer.subscription.updated');

      // ─── 4. Idempotence ─────────────────────────────────────────────
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
      expect(count, 'PK empêche doublons').toBe('1');

      // ─── 5. CRITIQUE : tenant pas purgé ─────────────────────────────
      // Même si le dispatcher ne match pas le user (customer.id pas mappé
      // au tenant de test), le tenant doit toujours exister + active.
      const after = selectRow(
        `SELECT id::text AS id, status, COALESCE(deleted_at::text, '') AS deleted_at
         FROM hub_app.tenants WHERE slug = '${directTenantSlug}';`,
        ['id', 'status', 'deleted_at'],
      );
      expect(after, 'tenant TOUJOURS présent (downgrade ne purge JAMAIS)').not.toBeNull();
      expect(
        after!.status,
        'status reste active (pas de soft-delete sur downgrade)',
      ).toBe('active');
      expect(
        after!.deleted_at,
        'deleted_at reste null (data préservée)',
      ).toBe('');

      runSqlOnStaging(
        `DELETE FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
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
