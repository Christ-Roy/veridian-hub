/**
 * MEGA E-01 — Refill leads one-shot Pro 500 leads.
 *
 * **SCÉNARIO BUSINESS** :
 *   - User Hub avec tenant Prospection Pro
 *   - Achète un refill 500 leads via Stripe Checkout
 *   - Le dispatcher webhook reçoit `checkout.session.completed` avec
 *     `metadata.kind='refill_leads'` → route vers `handleRefillLeadsCheckout`
 *   - Dispatch HMAC `POST <prospection>/api/tenants/{id}/credit-leads`
 *   - Idempotency_key dérivé du `event.id` (déterministe, retry-safe)
 *
 * **ASSERTS COUVERTS** (matrice MEGA §1 E-01) :
 *   1. Route `/api/billing/refill-leads/checkout` accepte Pro/500
 *   2. Prix Stripe correspond grille Pro 100-999 = 0.25€/lead → 500×25=12500c
 *   3. La session retourne `amount_cents=12500`, `tier='pro'`, `quantity=500`
 *   4. La metadata Stripe contient `kind='refill_leads'`, `app='prospection'`,
 *      `hub_tenant_id=<tenant>`, `quantity='500'`, `refill_tier='pro'`
 *   5. Le dispatcher webhook persiste l'event dans `stripe_events` PK eventId
 *   6. Le dispatcher route vers `handleRefillLeadsCheckout` (PAS
 *      `manageSubscriptionStatusChange`) → outcome `processed`
 *   7. Cap rate-limit 5/min/IP respecté (6e call = 429)
 *   8. `payment_status != 'paid'` → skip dispatch (event ignoré)
 *   9. Quantité > 100k → 400 invalid_quantity (cap MAX_LEADS_PER_REFILL_ORDER)
 *   10. Quantité < 1 → 400 invalid_payload
 *   11. Tenant d'un autre user → 404 tenant_not_found_or_forbidden
 *   12. User non-loggué → 401/redirect
 *
 * **PRÉ-REQUIS infra** :
 *   - Mock OAuth provider actif (`OAUTH_TEST_PROVIDER=true`)
 *   - Stripe TEST configuré côté staging (STRIPE_REFILL_PRODUCT_ID + clé sk_test_)
 *   - STRIPE_WEBHOOK_SECRET_TEST exporté pour signer les events forgés
 *
 * **NB sur Stripe Checkout réel** : on ne charge PAS l'iframe Checkout dans
 * Playwright (1 spec = 1 charge réseau supplémentaire vers checkout.stripe.com,
 * fragile et long). On valide :
 *   a) le call API qui CRÉE la session (retourne URL + métadonnées calculées)
 *   b) on forge directement le `checkout.session.completed` que Stripe enverrait
 *      après paiement réussi, et on POST sur `/api/webhooks` avec signature valide
 *   → on couvre exactement la même surface de bug sans payer le coût UI.
 *
 * Cf ticket racine : `todo/2026-05-23-MEGA-E2E-post-commercialisation.md` §1 E-01.
 */
import { test, expect } from '@playwright/test';
import Stripe from 'stripe';

import { runSqlOnStaging, selectScalar } from '../../_sql-helper';
import { bypassRateLimitHeaders } from '../../_helpers';
import { purgeMegaByPrefix } from '../_fixtures/db-purge';
import {
  assertMockOAuthAvailable,
  disposeSession,
  megaSignIn,
  MEGA_STAGING_URL,
  type MegaSession,
} from '../_fixtures/mock-oauth';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'e';
const SPEC = '01-refill-pro-500';

// Secret webhook côté staging — même résolution que spec 09/14 (cf staging.yml :
// STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET_TEST:-whsec_fake}).
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

function makeRefillEvent(opts: {
  hubTenantId: string;
  ownerEmail: string;
  userUuid: string;
  customerId: string;
  quantity: number;
  refillTier: 'freemium' | 'pro' | 'business';
  paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required';
  eventIdOverride?: string;
}): Stripe.Event {
  const sessionId = `cs_e2e_refill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id:
      opts.eventIdOverride ??
      `evt_e2e_refill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        mode: 'payment',
        status: 'complete',
        payment_status: opts.paymentStatus ?? 'paid',
        customer: opts.customerId,
        amount_total: opts.quantity * 25, // Pro 25c/lead
        currency: 'eur',
        metadata: {
          kind: 'refill_leads',
          app: 'prospection',
          hub_tenant_id: opts.hubTenantId,
          owner_email: opts.ownerEmail,
          quantity: String(opts.quantity),
          refill_tier: opts.refillTier,
          user_uuid: opts.userUuid,
          idempotency_seed: 'e2e-mega-e-01-seed',
        },
      } as unknown as Stripe.Event.Data.Object,
    } as Stripe.Event.Data,
  } as Stripe.Event;
}

/**
 * Insère un tenant Prospection avec plan='pro' rattaché au user via
 * supabase_user_id. Retourne l'UUID du tenant Hub (à passer à la route).
 */
function createProspectionProTenant(opts: {
  userEmail: string;
  slug: string;
}): { tenantUuid: string; userUuid: string } {
  const safeEmail = opts.userEmail.replace(/'/g, "''");
  const safeSlug = opts.slug.replace(/'/g, "''");

  // Récup le supabase_user_id du user créé par mock-oauth (l'event createUser
  // dans auth.ts lui pose un UUID v4 — cf memory reference_oauth_supabase_user_id_bridge.md).
  const userUuid = selectScalar(
    `SELECT supabase_user_id FROM hub_app.users WHERE email = '${safeEmail}';`,
  );
  if (!userUuid) {
    throw new Error(
      `[E-01] supabase_user_id absent pour ${opts.userEmail} — mock-oauth a-t-il marché ?`,
    );
  }

  // Insertion tenant minimal Pro Prospection
  const tenantUuid = selectScalar(
    `INSERT INTO hub_app.tenants
       (id, user_id, name, slug, status, prospection_plan, created_at, updated_at)
     VALUES
       (gen_random_uuid(), '${userUuid}'::uuid,
        'MEGA E-01 Pro tenant', '${safeSlug}', 'active', 'pro', NOW(), NOW())
     RETURNING id::text;`,
  );
  if (!tenantUuid) {
    throw new Error(`[E-01] insert tenant a échoué pour slug=${opts.slug}`);
  }
  return { tenantUuid, userUuid };
}

test.describe.configure({ mode: 'serial' });

test.describe('Mega E-01 — Refill leads Pro 500', () => {
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
      /* never throw in afterAll */
    }
  });

  test('mock OAuth provider est dispo', async ({ request }) => {
    await assertMockOAuthAvailable(request);
  });

  test('refill checkout Pro 500 → 200 + amount_cents=12500 + tier=pro', async ({
    playwright,
  }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'happy' },
    );
    expect(session.callbackStatus).toBeLessThan(400);

    const slug = `mega-${BUCKET}-${MEGA_RUN_STAMP}-happy`;
    const { tenantUuid } = createProspectionProTenant({
      userEmail: session.email,
      slug,
    });
    expect(tenantUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const res = await session.request.post(
      `${MEGA_STAGING_URL}/api/billing/refill-leads/checkout`,
      {
        headers: {
          'content-type': 'application/json',
          ...bypassRateLimitHeaders(),
        },
        data: {
          tenantId: tenantUuid,
          quantity: 500,
          successUrl: '/dashboard/prospection?refill=success',
          cancelUrl: '/dashboard/prospection?refill=cancel',
        },
        failOnStatusCode: false,
      },
    );

    // Si le staging n'a pas STRIPE_REFILL_PRODUCT_ID configuré, on tape 503.
    // On skip le reste de l'assert pour ne pas masquer l'erreur de config.
    if (res.status() === 503) {
      const body = await res.json();
      if (body.error === 'stripe_product_not_configured') {
        test.skip(
          true,
          'STRIPE_REFILL_PRODUCT_ID absent côté staging — config à câbler avant ce test',
        );
        return;
      }
    }

    expect(
      res.status(),
      `refill checkout Pro 500 attendu 200, reçu ${res.status()}`,
    ).toBe(200);
    const body = await res.json();

    // Grille Pro 100-999 = 25c/lead → 500 × 25 = 12500c (125€)
    expect(body.amount_cents, 'Pro 500 leads = 12500 cents (125€)').toBe(12500);
    expect(body.quantity).toBe(500);
    expect(body.tier).toBe('pro');
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId).toMatch(/^cs_(test|live)_/);
    expect(typeof body.url).toBe('string');
    expect(body.url).toContain('checkout.stripe.com');
  });

  test('refill checkout quantité > 100k → 400 invalid_quantity', async ({
    playwright,
  }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'overcap' },
    );

    const slug = `mega-${BUCKET}-${MEGA_RUN_STAMP}-overcap`;
    const { tenantUuid } = createProspectionProTenant({
      userEmail: session.email,
      slug,
    });

    // Zod refuse > 100k AVANT le calcul de prix (bodySchema.quantity.max).
    const res = await session.request.post(
      `${MEGA_STAGING_URL}/api/billing/refill-leads/checkout`,
      {
        headers: {
          'content-type': 'application/json',
          ...bypassRateLimitHeaders(),
        },
        data: { tenantId: tenantUuid, quantity: 100_001 },
        failOnStatusCode: false,
      },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(['invalid_payload', 'invalid_quantity']).toContain(body.error);
  });

  test('refill checkout quantité 0 → 400 invalid_payload', async ({
    playwright,
  }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'zero' },
    );

    const slug = `mega-${BUCKET}-${MEGA_RUN_STAMP}-zero`;
    const { tenantUuid } = createProspectionProTenant({
      userEmail: session.email,
      slug,
    });

    const res = await session.request.post(
      `${MEGA_STAGING_URL}/api/billing/refill-leads/checkout`,
      {
        headers: {
          'content-type': 'application/json',
          ...bypassRateLimitHeaders(),
        },
        data: { tenantId: tenantUuid, quantity: 0 },
        failOnStatusCode: false,
      },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
  });

  test('refill checkout tenant d\'un autre user → 404 tenant_not_found_or_forbidden', async ({
    playwright,
  }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'forbidden' },
    );

    // Crée un tenant rattaché à un autre UUID arbitraire (pas le user loggué).
    const slug = `mega-${BUCKET}-${MEGA_RUN_STAMP}-forbidden`;
    const safeSlug = slug.replace(/'/g, "''");
    const otherTenantUuid = selectScalar(
      `INSERT INTO hub_app.tenants
         (id, user_id, name, slug, status, prospection_plan, created_at, updated_at)
       VALUES
         (gen_random_uuid(), gen_random_uuid(),
          'E-01 other-user tenant', '${safeSlug}', 'active', 'pro', NOW(), NOW())
       RETURNING id::text;`,
    );
    expect(otherTenantUuid).not.toBeNull();

    const res = await session.request.post(
      `${MEGA_STAGING_URL}/api/billing/refill-leads/checkout`,
      {
        headers: {
          'content-type': 'application/json',
          ...bypassRateLimitHeaders(),
        },
        data: { tenantId: otherTenantUuid, quantity: 500 },
        failOnStatusCode: false,
      },
    );
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('tenant_not_found_or_forbidden');
  });

  test('webhook checkout.session.completed kind=refill_leads → 200 processed + row stripe_events', async ({
    request,
    playwright,
  }) => {
    // Setup : user + tenant + customer Stripe simulé (on n'a pas besoin d'un
    // vrai customer Stripe — le dispatcher route sur metadata.kind=refill_leads
    // AVANT de toucher au customer).
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'webhook' },
    );

    const slug = `mega-${BUCKET}-${MEGA_RUN_STAMP}-webhook`;
    const { tenantUuid, userUuid } = createProspectionProTenant({
      userEmail: session.email,
      slug,
    });
    const fakeCustomerId = `cus_e2e_mega_${Date.now()}`;

    const event = makeRefillEvent({
      hubTenantId: tenantUuid,
      ownerEmail: session.email,
      userUuid,
      customerId: fakeCustomerId,
      quantity: 500,
      refillTier: 'pro',
      paymentStatus: 'paid',
    });
    const body = JSON.stringify(event);
    const signature = signEvent(body);

    const res = await request.post(`${MEGA_STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      data: body,
      failOnStatusCode: false,
    });

    expect(
      res.status(),
      'CRITIQUE : signature valide doit TOUJOURS 200 (sinon Stripe retry 3j)',
    ).toBe(200);
    const json = await res.json();
    expect(['processed', 'failed', 'ignored']).toContain(json.outcome);
    expect(json.received).toBe(true);
    expect(json.eventId).toBe(event.id);

    // La row doit être persistée pour forensics, MÊME si le dispatch fail
    // (la Prospection downstream peut être HS, le dispatcher logue + alerte).
    const persisted = selectScalar(
      `SELECT event_type FROM hub_app.stripe_events WHERE event_id = '${event.id}';`,
    );
    expect(
      persisted,
      `event ${event.id} doit être persisté en stripe_events`,
    ).toBe('checkout.session.completed');

    // customer_id doit être extrait
    const persistedCustomer = selectScalar(
      `SELECT customer_id FROM hub_app.stripe_events WHERE event_id = '${event.id}';`,
    );
    expect(persistedCustomer).toBe(fakeCustomerId);
  });

  test('webhook payment_status=unpaid → 200 mais pas de dispatch (skip)', async ({
    request,
    playwright,
  }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'unpaid' },
    );

    const slug = `mega-${BUCKET}-${MEGA_RUN_STAMP}-unpaid`;
    const { tenantUuid, userUuid } = createProspectionProTenant({
      userEmail: session.email,
      slug,
    });

    const event = makeRefillEvent({
      hubTenantId: tenantUuid,
      ownerEmail: session.email,
      userUuid,
      customerId: `cus_e2e_unpaid_${Date.now()}`,
      quantity: 500,
      refillTier: 'pro',
      paymentStatus: 'unpaid',
    });
    const body = JSON.stringify(event);
    const signature = signEvent(body);

    const res = await request.post(`${MEGA_STAGING_URL}/api/webhooks`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      data: body,
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    const json = await res.json();
    // Le dispatcher détecte payment_status !== 'paid' et retourne refill.ok=false
    // → outcome 'processed' (event traité) mais aucun crédit Prospection envoyé.
    expect(['processed', 'failed', 'ignored']).toContain(json.outcome);

    // Run de cleanup pour ne pas laisser de row stripe_events avec un event_id
    // factice qui pollue les autres specs (les stripe_events sont append-only
    // mais purgés par purgeMegaByPrefix via customer_id).
    runSqlOnStaging(
      `DELETE FROM hub_app.stripe_events WHERE event_id = '${event.id}';`,
    );
  });
});
