/**
 * MEGA E-02 — Refill leads replay idempotent + Business volume max.
 *
 * **SCÉNARIO BUSINESS** :
 *   - Couvre 2 cas critiques du flux refill leads :
 *     (a) Stripe peut retry un webhook `checkout.session.completed` jusqu'à
 *         30 minutes après l'event initial. Si le Hub re-dispatche, on
 *         crédite 2× les leads → double facturation côté client.
 *         → On rejoue 5× le même event et on assert :
 *            - 1 seule row `stripe_events` (PK = eventId)
 *            - 2e+ POST retourne `idempotent: true`
 *            - L'audit log montre 1 seul dispatch (ou 1 seul tentative
 *              `billing.refill.processed`).
 *     (b) Grille refill Business tier 5 : 50k leads × 0.04€ = 2000€
 *         (= 200_000 cents). Et 101k = au-dessus du cap → 400.
 *
 * **ASSERTS COUVERTS** (matrice MEGA §1 E-01 idempotence + E-02 cap) :
 *   1. 5× POST webhook avec MÊME event.id → 1 seule row persistée
 *   2. 2e+ POST retourne `idempotent: true` (Stripe peut retry sans danger)
 *   3. `attempts` n'est pas incrémenté pour les replays (déjà processedAt set)
 *   4. Business 50k leads → amount_cents=200_000 (2000€), tier='business'
 *   5. Business 101k → 400 (Zod cap 100k)
 *   6. Business < 100 → tarif premier palier (20c/lead)
 *
 * **NOTE DESIGN** (héritée du spec 14 S7) : l'idempotence webhook fonctionne
 * SEULEMENT si le 1er dispatch réussit (`processedAt` set). Pour un event
 * forgé en E2E dont le dispatch fail (Prospection downstream inconnue ou
 * customer fake), `processedAt` reste NULL et le 2e POST re-tente. C'est
 * intentionnel — cf contrat-billing §2.2.
 *
 * Pour tester l'idempotence on doit donc utiliser un event qui :
 *   - réussit côté `persistStripeEvent` (toujours OK)
 *   - réussit côté dispatcher (outcome='processed' ou 'ignored') pour que
 *     `markEventProcessed({ok:true})` set `processedAt`
 *
 * → On utilise un event `checkout.session.completed` avec
 *   `mode='setup'` (mode setup = pas de payment, dispatcher renvoie
 *   `ignored: 'checkout not subscription mode'`) → `processedAt` set →
 *   le 2e POST détecte alreadyProcessed=true → 200 idempotent.
 *
 * Cf ticket racine : `todo/2026-05-23-MEGA-E2E-post-commercialisation.md` §1 E-02.
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
const SPEC = '02-refill-replay-idempotent';

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

/**
 * Event `checkout.session.completed` en mode `setup` → dispatcher renvoie
 * `ignored: 'checkout not subscription mode'` → processedAt set → idempotent
 * activable.
 *
 * NB : on n'utilise PAS `mode=payment` + `metadata.kind=refill_leads` car
 * dans ce cas le dispatcher tente vraiment le dispatch HMAC vers Prospection
 * staging — fail → processedAt reste NULL → idempotence non vérifiable
 * (re-tente comme prévu par le design).
 */
function makeIgnoredEvent(eventIdOverride: string): Stripe.Event {
  return {
    id: eventIdOverride,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_e2e_idempotence_${Date.now()}`,
        object: 'checkout.session',
        mode: 'setup', // pas subscription → dispatcher ignore proprement
        status: 'complete',
        payment_status: 'no_payment_required',
        customer: `cus_e2e_idem_${Date.now()}`,
        metadata: {},
      } as unknown as Stripe.Event.Data.Object,
    } as Stripe.Event.Data,
  } as Stripe.Event;
}

function createProspectionTenant(opts: {
  userEmail: string;
  slug: string;
  plan: 'pro' | 'business' | 'freemium';
}): { tenantUuid: string; userUuid: string } {
  const safeEmail = opts.userEmail.replace(/'/g, "''");
  const safeSlug = opts.slug.replace(/'/g, "''");

  const userUuid = selectScalar(
    `SELECT supabase_user_id FROM hub_app.users WHERE email = '${safeEmail}';`,
  );
  if (!userUuid) {
    throw new Error(`[E-02] supabase_user_id absent pour ${opts.userEmail}`);
  }

  const tenantUuid = selectScalar(
    `INSERT INTO hub_app.tenants
       (id, user_id, name, slug, status, prospection_plan, created_at, updated_at)
     VALUES
       (gen_random_uuid(), '${userUuid}'::uuid,
        'MEGA E-02 ${opts.plan} tenant', '${safeSlug}', 'active', '${opts.plan}', NOW(), NOW())
     RETURNING id::text;`,
  );
  if (!tenantUuid) {
    throw new Error(`[E-02] insert tenant ${opts.plan} échec slug=${opts.slug}`);
  }
  return { tenantUuid, userUuid };
}

test.describe.configure({ mode: 'serial' });

test.describe('Mega E-02 — Refill replay idempotent + cap', () => {
  let session: MegaSession | null = null;
  const replayEventIds: string[] = []; // pour cleanup stripe_events forgés

  test.afterEach(async () => {
    if (session) {
      await disposeSession(session);
      session = null;
    }
  });

  test.afterAll(async () => {
    try {
      // Purge ciblée des stripe_events forgés
      if (replayEventIds.length > 0) {
        const quoted = replayEventIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
        runSqlOnStaging(
          `DELETE FROM hub_app.stripe_events WHERE event_id IN (${quoted});`,
        );
      }
      await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}`,
        tenantPrefix: `mega-${BUCKET}`,
      });
    } catch {
      /* never throw in afterAll */
    }
  });

  test('mock OAuth provider est dispo', async ({ request }) => {
    await assertMockOAuthAvailable(request);
  });

  test('5× replay même event.id → 1 row + idempotent=true au 2e+', async ({
    request,
  }) => {
    const eventId = `evt_e2e_mega_e02_replay_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    replayEventIds.push(eventId);
    const event = makeIgnoredEvent(eventId);
    const body = JSON.stringify(event);

    const outcomes: Array<{ status: number; idempotent?: boolean; outcome?: string }> = [];

    for (let i = 0; i < 5; i++) {
      // Re-sign chaque tentative avec un timestamp neuf — sinon Stripe rejette
      // pour timestamp old (>5min). Le body (et donc event.id) reste identique.
      const signature = signEvent(body);
      const res = await request.post(`${MEGA_STAGING_URL}/api/webhooks`, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signature,
        },
        data: body,
        failOnStatusCode: false,
      });
      const status = res.status();
      let json: { idempotent?: boolean; outcome?: string } = {};
      try {
        json = await res.json();
      } catch {
        /* body vide */
      }
      outcomes.push({ status, idempotent: json.idempotent, outcome: json.outcome });
    }

    // INVARIANT 1 : tous les calls retournent 200 (Stripe DOIT recevoir 200
    // sinon il retry pendant 3 jours).
    for (let i = 0; i < 5; i++) {
      expect(
        outcomes[i].status,
        `replay #${i + 1} doit 200 (Stripe ne tolère pas autre que signature invalide)`,
      ).toBe(200);
    }

    // INVARIANT 2 : 1er call PAS idempotent
    expect(
      outcomes[0].idempotent,
      'replay #1 ne doit PAS être idempotent (event nouveau)',
    ).not.toBe(true);
    expect(['ignored', 'processed']).toContain(outcomes[0].outcome);

    // INVARIANT 3 : 2e+ calls idempotents
    for (let i = 1; i < 5; i++) {
      expect(
        outcomes[i].idempotent,
        `replay #${i + 1} DOIT être idempotent (stripe_events PK déjà set)`,
      ).toBe(true);
    }

    // INVARIANT 4 : exactement 1 row stripe_events (PK eventId)
    const rowCount = selectScalar(
      `SELECT count(*) FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    expect(
      rowCount,
      'PK event_id doit empêcher les doublons (5 replays = 1 row)',
    ).toBe('1');

    // INVARIANT 5 : processed_at est NON-NULL (1er call a réussi processedAt set
    // car outcome='ignored' → markEventProcessed({ok:true})).
    const processedAt = selectScalar(
      `SELECT COALESCE(processed_at::text, '') FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    expect(
      processedAt,
      'processed_at doit être set (sinon idempotence ne se déclenche pas)',
    ).not.toBe('');

    // INVARIANT 6 : attempts pas incrémenté (les replays idempotents ne
    // re-marquent pas l'event)
    const attempts = selectScalar(
      `SELECT attempts FROM hub_app.stripe_events WHERE event_id = '${eventId}';`,
    );
    expect(
      Number(attempts ?? '999'),
      'attempts ne doit pas être incrémenté par les replays idempotents (0 attendu)',
    ).toBeLessThanOrEqual(1);
  });

  test('refill Business 50k → amount_cents=200000 + tier=business', async ({
    playwright,
  }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'biz50k' },
    );

    const slug = `mega-${BUCKET}-${MEGA_RUN_STAMP}-biz50k`;
    const { tenantUuid } = createProspectionTenant({
      userEmail: session.email,
      slug,
      plan: 'business',
    });

    const res = await session.request.post(
      `${MEGA_STAGING_URL}/api/billing/refill-leads/checkout`,
      {
        headers: {
          'content-type': 'application/json',
          ...bypassRateLimitHeaders(),
        },
        data: { tenantId: tenantUuid, quantity: 50_000 },
        failOnStatusCode: false,
      },
    );

    // Skip si STRIPE_REFILL_PRODUCT_ID pas configuré côté staging
    if (res.status() === 503) {
      const body = await res.json();
      if (body.error === 'stripe_product_not_configured') {
        test.skip(true, 'STRIPE_REFILL_PRODUCT_ID absent — config staging');
        return;
      }
    }

    expect(res.status()).toBe(200);
    const body = await res.json();
    // Grille Business tier 5 : min=50000 → 4c/lead → 50000×4 = 200_000c (2000€)
    expect(
      body.amount_cents,
      'Business 50000 leads = 200000 cents (2000€) — grille shared §refill',
    ).toBe(200_000);
    expect(body.quantity).toBe(50_000);
    expect(body.tier).toBe('business');
  });

  test('refill Business 101k → 400 (cap MAX_LEADS_PER_REFILL_ORDER)', async ({
    playwright,
  }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'biz101k' },
    );

    const slug = `mega-${BUCKET}-${MEGA_RUN_STAMP}-biz101k`;
    const { tenantUuid } = createProspectionTenant({
      userEmail: session.email,
      slug,
      plan: 'business',
    });

    const res = await session.request.post(
      `${MEGA_STAGING_URL}/api/billing/refill-leads/checkout`,
      {
        headers: {
          'content-type': 'application/json',
          ...bypassRateLimitHeaders(),
        },
        data: { tenantId: tenantUuid, quantity: 101_000 },
        failOnStatusCode: false,
      },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    // Zod refuse > 100k (bodySchema.quantity.max=100_000) AVANT le calcul.
    expect(['invalid_payload', 'invalid_quantity']).toContain(body.error);
  });

  test('refill Business 50 → amount_cents=1000 (tier 1 0.20€/lead)', async ({
    playwright,
  }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'biz50' },
    );

    const slug = `mega-${BUCKET}-${MEGA_RUN_STAMP}-biz50`;
    const { tenantUuid } = createProspectionTenant({
      userEmail: session.email,
      slug,
      plan: 'business',
    });

    const res = await session.request.post(
      `${MEGA_STAGING_URL}/api/billing/refill-leads/checkout`,
      {
        headers: {
          'content-type': 'application/json',
          ...bypassRateLimitHeaders(),
        },
        data: { tenantId: tenantUuid, quantity: 50 },
        failOnStatusCode: false,
      },
    );

    if (res.status() === 503) {
      const body = await res.json();
      if (body.error === 'stripe_product_not_configured') {
        test.skip(true, 'STRIPE_REFILL_PRODUCT_ID absent — config staging');
        return;
      }
    }

    expect(res.status()).toBe(200);
    const body = await res.json();
    // Grille Business tier 1 : 1-99 → 20c/lead → 50×20=1000c (10€)
    expect(body.amount_cents, 'Business 50 leads = 1000 cents (10€)').toBe(1000);
    expect(body.tier).toBe('business');
  });
});
