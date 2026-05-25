/**
 * MEGA D-04 — Plan offert immune au downgrade Stripe
 *
 * **SCÉNARIO** : tenant créé manuellement avec
 * `metadata.notifuse_plan_source='lifetime_site_vitrine'` → on simule
 * un event Stripe `customer.subscription.deleted` artificiel pour le
 * user du tenant → asserts que le tenant garde `notifusePlan='pro'`
 * (cf §3.3 CONTRAT-BILLING : immunité grant_manual / lifetime_*).
 *
 * **REF CODE** : `utils/stripe/prisma-sync.ts:260-269` —
 *   const isImmuneNotifuse = ['lifetime_site_vitrine', 'lifetime_partner',
 *     'internal'].includes(notifusePlanSource);
 *
 * **ASSERTS HARDCORE** (~9) :
 *   1. Tenant créé avec notifusePlan='pro' + metadata immune
 *   2. Sub Stripe créée pour le user du tenant
 *   3. Webhook subscription.deleted accepté (200)
 *   4. stripe_events row persistée
 *   5. event_type cohérent
 *   6. **CRITIQUE** : tenant.notifusePlan reste 'pro' (PAS downgrade à 'free')
 *   7. metadata.notifuse_plan_source reste 'lifetime_site_vitrine'
 *   8. Idempotence : 2× deleted → 1 row stripe_events
 *   9. Anti-régression : un 2e `subscription.deleted` ne touche toujours
 *      pas le plan (immunité durable, pas juste 1er événement)
 */
import { test, expect } from '@playwright/test';
import Stripe from 'stripe';

import { STAGING_URL, freshIpHeader } from '../../_helpers';
import { runSqlOnStaging, selectScalar, selectRow } from '../../_sql-helper';

import { purgeMegaByPrefix } from '../_fixtures/db-purge';
import { StripeConfigError } from '../_fixtures/stripe-api';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'd';

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

test.describe('Mega D-04 — Plan offert immune au downgrade Stripe', () => {
  // Tenant slug unique pour ce spec (créé directement en DB, pas via signup)
  const tenantSlug = `mega-${BUCKET}-${MEGA_RUN_STAMP}-immune`;
  // UUID déterministe valide pour le test (préfixe + run stamp)
  const tenantUserUuid =
    '22222222-2222-2222-2222-' +
    MEGA_RUN_STAMP.replace(/-/g, '').slice(0, 12).padEnd(12, '0');
  const tenantStripeCustomerId = `cus_mega_d04_${MEGA_RUN_STAMP}`;

  test.afterAll(async () => {
    // Cleanup tenant + subscription test + events
    try {
      runSqlOnStaging(
        `DELETE FROM hub_app.subscriptions
         WHERE stripe_customer_id = '${tenantStripeCustomerId}';`,
      );
      runSqlOnStaging(
        `DELETE FROM hub_app.tenants WHERE slug = '${tenantSlug}';`,
      );
    } catch {
      /* swallow */
    }
    try {
      await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}`,
        tenantPrefix: `mega-${BUCKET}`,
      });
    } catch {
      /* swallow */
    }
  });

  test('subscription.deleted sur tenant lifetime_site_vitrine → notifusePlan reste pro', async ({
    request,
  }) => {
    // ─── 1. Insert tenant immune en direct ──────────────────────────
    runSqlOnStaging(
      `INSERT INTO hub_app.tenants
         (id, user_id, name, slug, status, notifuse_plan, prospection_plan, metadata)
       VALUES
         (gen_random_uuid(), '${tenantUserUuid}'::uuid,
          'D-04 immune tenant', '${tenantSlug}', 'active',
          'pro', 'pro',
          '{"notifuse_plan_source": "lifetime_site_vitrine", "prospection_plan_source": "lifetime_site_vitrine"}'::jsonb)
       ON CONFLICT (slug) DO NOTHING;`,
    );

    // Sanity : tenant créé en pro + metadata posée
    const before = selectRow(
      `SELECT notifuse_plan,
              COALESCE(metadata->>'notifuse_plan_source', '') AS source
       FROM hub_app.tenants WHERE slug = '${tenantSlug}';`,
      ['notifuse_plan', 'source'],
    );
    expect(before, 'tenant créé').not.toBeNull();
    expect(before!.notifuse_plan).toBe('pro');
    expect(before!.source).toBe('lifetime_site_vitrine');

    // ─── 2. Insert sub Stripe active pour le user ────────────────────
    runSqlOnStaging(
      `INSERT INTO hub_app.subscriptions
         (id, user_id, stripe_customer_id, stripe_subscription_id, status, plan_name)
       VALUES
         (gen_random_uuid(), '${tenantUserUuid}'::uuid,
          '${tenantStripeCustomerId}', 'sub_mega_d04_${MEGA_RUN_STAMP}',
          'active', 'notifuse-pro')
       ON CONFLICT (stripe_subscription_id) DO NOTHING;`,
    );

    // ─── 3. Webhook subscription.deleted artificiel ──────────────────
    const eventId = `evt_mega_d04_${MEGA_RUN_STAMP}_${Math.random()
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
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: `sub_mega_d04_${MEGA_RUN_STAMP}`,
          object: 'subscription',
          customer: tenantStripeCustomerId,
          status: 'canceled',
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
      expect(res.status(), 'Webhook deleted accepté (200)').toBe(200);

      const persisted = selectScalar(
        `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
      );
      expect(persisted).toBe('customer.subscription.deleted');

      // ─── 4. CRITIQUE : tenant garde 'pro' (immunité) ─────────────
      // Le dispatcher passe par prisma-sync.ts qui check
      // metadata.notifuse_plan_source ∈ lifetime_* → ne touche pas le plan.
      const after = selectRow(
        `SELECT notifuse_plan,
                COALESCE(metadata->>'notifuse_plan_source', '') AS source
         FROM hub_app.tenants WHERE slug = '${tenantSlug}';`,
        ['notifuse_plan', 'source'],
      );
      expect(after, 'tenant TOUJOURS présent').not.toBeNull();
      expect(
        after!.notifuse_plan,
        'CRITIQUE : tenant lifetime_site_vitrine ne doit JAMAIS être downgrade par un webhook Stripe (cf §3.3 CONTRAT-BILLING)',
      ).toBe('pro');
      expect(
        after!.source,
        'metadata.notifuse_plan_source préservé',
      ).toBe('lifetime_site_vitrine');

      // ─── 5. Idempotence : 2× deleted → 1 row event ─────────────
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

      // ─── 6. Anti-régression : 2e deleted avec event_id différent ─
      // Immunité durable, pas juste sur le 1er événement reçu.
      const eventId2 = `${eventId}-bis`;
      const event2 = { ...event, id: eventId2 };
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
      expect(res2.status()).toBe(200);

      const after2 = selectRow(
        `SELECT notifuse_plan FROM hub_app.tenants WHERE slug = '${tenantSlug}';`,
        ['notifuse_plan'],
      );
      expect(
        after2!.notifuse_plan,
        'Immunité durable : 2e deleted ne touche pas non plus le plan',
      ).toBe('pro');

      runSqlOnStaging(
        `DELETE FROM hub_app.stripe_events
         WHERE event_id IN ('${eventId}', '${eventId2}');`,
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
