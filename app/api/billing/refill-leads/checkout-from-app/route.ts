/**
 * POST /api/billing/refill-leads/checkout-from-app
 *
 * Variante HMAC-authentifiée de `app/api/billing/refill-leads/checkout/route.ts`
 * — utilisée par une app downstream (Prospection) qui veut INITIER un Stripe
 * Checkout one-shot refill côté Hub depuis sa propre UI (page native refill
 * ICP). L'app appelle le Hub server-to-server en HMAC Pattern A ; le Hub
 * reste seul interlocuteur Stripe (CONTRAT-BILLING §2 + §8.4).
 *
 * Spec : `todo/2026-05-25-refill-checkout-from-app-hmac-route.md`
 * Contrat : `docs/CONTRAT-BILLING.md` §8.4 (refill v2.1)
 *
 * Auth : HMAC Pattern A entrant (réutilise `PROSPECTION_HUB_API_SECRET` —
 *        canonique §6.1, pas de nouveau secret par scope).
 *
 * Différences vs la route session-gated `/checkout` :
 *   - Auth = HMAC (vs `requireUser`)
 *   - Le `tenant_id` du body est l'autorité (vs ownership user-tenant) — l'app
 *     a déjà vérifié que SON user owne SON workspace côté Prospection
 *   - Le `plan` est passé par l'app dans le body (pas dérivé du tenant —
 *     l'app sait son plan local, ce qui évite un round-trip)
 *   - Forward optionnel d'un objet `filters_json` dans la metadata Stripe →
 *     re-propagé au webhook → injecté dans le `credit-leads` body (v2.1)
 *   - `success_url` / `cancel_url` acceptent une URL absolue (l'app retourne
 *     sur SON propre domaine après paiement, pas sur le Hub)
 *
 * Body (v2.1) :
 *   {
 *     tenant_id: <uuid Hub>,
 *     quantity: <int 1..100000>,
 *     plan: 'freemium' | 'pro' | 'business',
 *     filters_json?: { ... },     // optionnel, propagé en metadata Stripe
 *     success_url?: <https URL>,
 *     cancel_url?: <https URL>,
 *     contract_version: '2.1',
 *   }
 *
 * Response 200 :
 *   { url, sessionId, amount_cents, quantity, tier }
 *
 * Erreurs :
 *   - 400 invalid body / missing headers / invalid HMAC headers shape
 *   - 401 invalid HMAC signature / drift
 *   - 403 app non whitelisted (header HMAC ≠ 'prospection')
 *   - 404 tenant_not_found (UUID inconnu en DB Hub)
 *   - 422 stripe_session_failed (Stripe rejette le payload)
 *   - 429 rate_limited
 *   - 503 stripe_not_configured / database_error
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { stripe } from '@/utils/stripe/config';
import { resolveStripeCustomerId } from '@/utils/stripe/server';
import { getStripeRefillProductId } from '@/utils/env';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { verifyBillingStateHmac } from '@/lib/billing/billing-state-hmac';
import { isPublicHttpUrl } from '@/lib/security/safe-url';
import { getURL } from '@/utils/helpers';
import {
  priceRefillCents,
  checkoutSeedIdempotencyKey,
  mapProspectionPlanToRefillTier,
  type ProspectionLocalPlan,
  RefillQuantityError,
} from '@/lib/billing/refill-leads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Limite Stripe metadata par valeur : 500 chars. Au-delà → truncate + warning.
// Cf https://docs.stripe.com/api/metadata.
const STRIPE_METADATA_VALUE_MAX = 500;

/**
 * Rate-limit par app HMAC (clé = nom de l'app vérifié) : 60 req/min/app.
 * Une app downstream qui spamme la création de session Stripe est anormale —
 * le payant Stripe filtre déjà mais on ajoute un frein cheap côté Hub.
 */
const refillCheckoutFromAppLimiter = new RateLimiter({
  capacity: 60,
  windowMs: 60_000,
  name: 'refill-checkout-from-app',
});

const ALLOWED_PROSPECTION_PLANS: readonly ProspectionLocalPlan[] = [
  'freemium',
  'pro',
  'business',
] as const;

/**
 * Apps autorisées à initier un refill checkout côté Hub.
 * Pour l'instant seul Prospection a la feature ; on garde l'enum explicite
 * pour qu'un agent qui ajoute une autre app passe par une revue claire.
 */
const REFILL_INITIATOR_APPS = ['prospection'] as const;

const bodySchema = z.object({
  tenant_id: z.string().uuid({ message: 'tenant_id must be a UUID' }),
  quantity: z.number().int().min(1).max(100_000),
  plan: z.enum(ALLOWED_PROSPECTION_PLANS as unknown as [string, ...string[]]),
  filters_json: z.record(z.string(), z.unknown()).optional(),
  // SSRF guard : Stripe Checkout fait un redirect navigateur ; un attaquant
  // qui contrôle success_url/cancel_url peut envoyer le payeur vers du
  // javascript:/data:/file:/IP-interne. Cf `lib/security/safe-url.ts` +
  // ticket `todo/2026-05-25-ssrf-link-app-fallback-url-cloud-metadata.md`.
  success_url: z
    .string()
    .max(2048)
    .refine(isPublicHttpUrl, {
      message:
        'success_url must be a public http(s) URL (no private/loopback/metadata IPs, no internal hostnames, no file:/javascript:/data: schemes)',
    })
    .optional(),
  cancel_url: z
    .string()
    .max(2048)
    .refine(isPublicHttpUrl, {
      message:
        'cancel_url must be a public http(s) URL (no private/loopback/metadata IPs, no internal hostnames, no file:/javascript:/data: schemes)',
    })
    .optional(),
  contract_version: z.literal('2.1'),
});

export async function POST(request: Request) {
  // ─── 1. Lire le rawBody (HMAC signe les bytes EXACTS) ───
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  // ─── 2. HMAC verify AVANT le rate-limit "par app" (sinon spoofable) ───
  // On réutilise verifyBillingStateHmac : le helper implémente le Pattern A
  // §6.1 (X-Veridian-Timestamp + X-Veridian-Hub-Signature + x-veridian-app)
  // et résout le secret canonique `<APP>_HUB_API_SECRET`. Le nom du helper
  // est legacy (livré pour billing-state) mais la logique est générique.
  const hmac = verifyBillingStateHmac(request.headers, rawBody);
  if (!hmac.ok) {
    return NextResponse.json(
      { error: 'unauthorized', reason: hmac.reason },
      { status: hmac.status },
    );
  }

  // ─── 3. App whitelist : seul Prospection peut initier un refill checkout ───
  if (!(REFILL_INITIATOR_APPS as readonly string[]).includes(hmac.app)) {
    return NextResponse.json(
      {
        error: 'app_not_whitelisted',
        reason: `app=${hmac.app} cannot initiate refill checkout`,
      },
      { status: 403 },
    );
  }

  // ─── 4. Rate-limit par app HMAC ───
  const rate = refillCheckoutFromAppLimiter.enforce(`app:${hmac.app}`);
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'rate_limited', retry_after_seconds: rate.retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  // ─── 5. Parse + validate body ───
  let json: unknown;
  try {
    json = rawBody.length === 0 ? null : JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { tenant_id, quantity, plan, filters_json, success_url, cancel_url } =
    parsed.data;
  // Refine: `plan` est validé par z.enum mais le type TS sort en `string` à
  // cause du cast unknown ci-dessus — on resserre.
  const prospectionPlan = plan as ProspectionLocalPlan;

  // ─── 6. Tenant lookup (pas de check user-ownership : c'est l'app qui garantit) ─
  // L'app appelante (Prospection) a déjà vérifié côté server que SON user
  // owne SON workspace local et que le tenant Hub référence ce workspace.
  // Le Hub fait juste un check d'existence + soft-delete state.
  let tenant: {
    id: string;
    userId: string;
    prospectionPlan: string | null;
  } | null;
  try {
    tenant = await prisma.tenant.findFirst({
      where: { id: tenant_id, deletedAt: null },
      select: { id: true, userId: true, prospectionPlan: true },
    });
  } catch (dbErr) {
    console.error('[refill-checkout-from-app] tenant lookup failed:', dbErr);
    return NextResponse.json({ error: 'database_error' }, { status: 503 });
  }

  if (!tenant) {
    return NextResponse.json({ error: 'tenant_not_found' }, { status: 404 });
  }

  // ─── 7. Resolve owner email (nécessaire pour Stripe Customer + metadata) ─
  // `tenant.userId` est l'UUID bridge `User.supabaseUserId` côté Hub.
  // Hub stocke aussi cet UUID directement sur Tenant donc on lookup user par
  // ce champ. Si introuvable → 503 (état corrompu côté Hub).
  const owner = await prisma.user.findFirst({
    where: { supabaseUserId: tenant.userId },
    select: { id: true, email: true, supabaseUserId: true },
  });
  if (!owner || !owner.email || !owner.supabaseUserId) {
    console.error(
      `[refill-checkout-from-app] owner not found for tenant=${tenant.id} userId=${tenant.userId}`,
    );
    return NextResponse.json({ error: 'database_error' }, { status: 503 });
  }

  // ─── 8. Calcul prix via grille shared ───
  let totalCents: number;
  try {
    totalCents = priceRefillCents(prospectionPlan, quantity);
  } catch (err) {
    if (err instanceof RefillQuantityError) {
      return NextResponse.json(
        { error: 'invalid_quantity', message: err.message },
        { status: 400 },
      );
    }
    console.error('[refill-checkout-from-app] price calc failed:', err);
    return NextResponse.json(
      { error: 'pricing_error', message: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    );
  }

  // ─── 9. Resolve Stripe Product (env LIVE/TEST aware) ───
  let productId: string;
  try {
    productId = getStripeRefillProductId();
  } catch (err) {
    console.error('[refill-checkout-from-app] STRIPE_REFILL_PRODUCT_ID missing:', err);
    return NextResponse.json({ error: 'stripe_not_configured' }, { status: 503 });
  }

  // ─── 10. Resolve / create Stripe Customer pour le owner Hub ───
  let customerId: string;
  try {
    customerId = await resolveStripeCustomerId(owner.supabaseUserId, owner.email);
  } catch (err) {
    console.error('[refill-checkout-from-app] customer resolution failed:', err);
    return NextResponse.json({ error: 'stripe_customer_failed' }, { status: 502 });
  }

  // ─── 11. URLs success/cancel ───
  // Pas de fallback /dashboard — l'app appelante DOIT fournir ses URLs (elle
  // sait où renvoyer son user). Si l'app ne fournit rien → fallback domaine
  // Hub via getURL() (résout NEXT_PUBLIC_SITE_URL côté Hub, déjà documenté
  // dans .env.example). En pratique Prospection enverra ses propres URLs
  // absolues vers son domaine.
  const successFullUrl =
    success_url ?? getURL('/dashboard/prospection?refill=success');
  const cancelFullUrl =
    cancel_url ?? getURL('/dashboard/prospection?refill=cancel');

  // ─── 12. Truncate filters_json si > limite Stripe metadata ───
  // Option A du ticket §1 : stocker dans metadata Stripe. Si trop long →
  // truncate + warning log. Si on rencontre le mur en pratique, on migre vers
  // option B (table dédiée + ref id).
  let filtersJsonForMetadata: string | undefined;
  if (filters_json !== undefined) {
    const serialized = JSON.stringify(filters_json);
    if (serialized.length > STRIPE_METADATA_VALUE_MAX) {
      console.warn(
        JSON.stringify({
          tag: '[refill-checkout-from-app][filters_truncate]',
          level: 'warn',
          tenant_id,
          quantity,
          filters_size: serialized.length,
          limit: STRIPE_METADATA_VALUE_MAX,
          message:
            'filters_json > 500 chars — truncated for Stripe metadata. ' +
            'Consider Option B (filters_ref table) if recurrent.',
          ts: new Date().toISOString(),
        }),
      );
      filtersJsonForMetadata = serialized.slice(0, STRIPE_METADATA_VALUE_MAX);
    } else {
      filtersJsonForMetadata = serialized;
    }
  }

  // ─── 13. Build metadata (compat avec dispatcher checkout.session.completed) ─
  const metadata: Record<string, string> = {
    kind: 'refill_leads',
    app: hmac.app,
    hub_tenant_id: tenant.id,
    owner_email: owner.email,
    quantity: String(quantity),
    refill_tier: mapProspectionPlanToRefillTier(prospectionPlan),
    user_uuid: owner.supabaseUserId,
    idempotency_seed: checkoutSeedIdempotencyKey(tenant.id, quantity),
    contract_version: '2.1',
    initiated_from: 'app',
  };
  if (filtersJsonForMetadata !== undefined) {
    metadata.filters_json = filtersJsonForMetadata;
  }

  // ─── 14. Create Stripe Checkout Session ───
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: totalCents,
            product: productId,
            tax_behavior: 'exclusive',
          },
        },
      ],
      metadata,
      payment_intent_data: { metadata },
      success_url: successFullUrl,
      cancel_url: cancelFullUrl,
    });

    if (!session.url) {
      return NextResponse.json(
        { error: 'stripe_session_no_url' },
        { status: 422 },
      );
    }

    return NextResponse.json({
      url: session.url,
      sessionId: session.id,
      amount_cents: totalCents,
      quantity,
      tier: prospectionPlan,
    });
  } catch (err) {
    console.error('[refill-checkout-from-app] Stripe session creation failed:', err);
    return NextResponse.json(
      {
        error: 'stripe_session_failed',
        details: { message: err instanceof Error ? err.message : 'unknown' },
      },
      { status: 422 },
    );
  }
}
