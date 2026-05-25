// POST /api/billing/refill-leads/checkout
//
// Crée une session Stripe Checkout one-shot (`mode=payment`) pour acheter N
// leads supplémentaires sur un workspace Prospection appartenant au user
// connecté.
//
// Spec : docs/CONTRAT-BILLING.md §8.4 (refill = flux séparé de `update-plan`),
// docs/PRICING-VERIDIAN.md §95-108 (grille dégressive).
//
// Body :
//   {
//     tenantId: <uuid Hub Tenant>,
//     quantity: 1..100000,
//     successUrl?: "/dashboard/prospection?refill=success",
//     cancelUrl?:  "/dashboard/prospection?refill=cancel",
//   }
//
// Response 200 : { url, sessionId }
// Response 4xx/5xx : { error, details? }
//
// Le webhook Stripe `checkout.session.completed` (lib/stripe/dispatcher.ts)
// décode `session.metadata.kind === 'refill_leads'` pour dispatcher le crédit
// vers `POST <prospection>/api/tenants/{id}/credit-leads`.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { stripe } from '@/utils/stripe/config';
import { resolveStripeCustomerId } from '@/utils/stripe/server';
import { getStripeRefillProductId } from '@/utils/env';
import { getURL } from '@/utils/helpers';
import {
  priceRefillCents,
  checkoutSeedIdempotencyKey,
  mapProspectionPlanToRefillTier,
  type ProspectionLocalPlan,
  RefillQuantityError,
} from '@/lib/billing/refill-leads';
import { RateLimiter, extractClientIp } from '@/lib/auth/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 5 req/min/IP — défense en profondeur, le payant Stripe filtre déjà. */
const refillCheckoutLimiter = new RateLimiter({
  capacity: 5,
  windowMs: 60_000,
  name: 'refill-checkout',
});

const ALLOWED_PROSPECTION_PLANS: readonly ProspectionLocalPlan[] = [
  'freemium',
  'pro',
  'business',
] as const;

const bodySchema = z.object({
  tenantId: z.string().uuid({ message: 'tenantId must be a UUID' }),
  quantity: z.number().int().min(1).max(100_000),
  successUrl: z
    .string()
    .startsWith('/', { message: 'successUrl must be a relative path' })
    .max(512)
    .optional(),
  cancelUrl: z
    .string()
    .startsWith('/', { message: 'cancelUrl must be a relative path' })
    .max(512)
    .optional(),
});

export async function POST(request: NextRequest) {
  // ─── Rate-limit (anti-spam Checkout creation) ───
  // `enforceWithBypass` accepte le header `x-veridian-e2e-bypass-ratelimit`
  // hors prod (DEPLOY_ENV !== 'prod') — la suite MEGA E2E enchaîne 6+ refill
  // checkouts en série sur la même IP Traefik, sinon 429 cascade après le 5e.
  const ip = extractClientIp(request.headers);
  const rate = refillCheckoutLimiter.enforceWithBypass(ip, request.headers);
  if (!rate.ok) {
    return NextResponse.json(
      { error: 'rate_limited', retry_after_seconds: rate.retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  // ─── Auth ───
  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }
  if (!user.email) {
    return NextResponse.json({ error: 'user_no_email' }, { status: 400 });
  }

  // ─── Body parsing + validation ───
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { tenantId, quantity, successUrl, cancelUrl } = parsed.data;

  const userUuidValue = userUuid(user);

  // ─── Ownership check : le tenant doit appartenir au user connecté ───
  // Sécurité critique : sans ce check, un user pourrait acheter des leads
  // pour le workspace d'un autre user (escalation horizontale).
  let tenant: { id: string; prospectionPlan: string | null } | null;
  try {
    tenant = await prisma.tenant.findFirst({
      where: { id: tenantId, userId: userUuidValue, deletedAt: null },
      select: { id: true, prospectionPlan: true },
    });
  } catch (dbErr) {
    console.error('[refill-checkout] tenant lookup failed:', dbErr);
    return NextResponse.json({ error: 'database_error' }, { status: 503 });
  }

  if (!tenant) {
    return NextResponse.json(
      { error: 'tenant_not_found_or_forbidden' },
      { status: 404 },
    );
  }

  // ─── Plan local Prospection (fallback freemium si null/inconnu) ───
  const rawPlan = (tenant.prospectionPlan ?? 'freemium').toLowerCase();
  const prospectionPlan: ProspectionLocalPlan =
    (ALLOWED_PROSPECTION_PLANS as readonly string[]).includes(rawPlan)
      ? (rawPlan as ProspectionLocalPlan)
      : 'freemium';

  // ─── Calcul du prix via la grille shared ───
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
    console.error('[refill-checkout] price calculation failed:', err);
    return NextResponse.json(
      { error: 'pricing_error', message: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    );
  }

  // ─── Resolve Product ID Stripe (env LIVE/TEST aware) ───
  let productId: string;
  try {
    productId = getStripeRefillProductId();
  } catch (err) {
    console.error('[refill-checkout] STRIPE_REFILL_PRODUCT_ID missing:', err);
    return NextResponse.json(
      { error: 'stripe_product_not_configured' },
      { status: 503 },
    );
  }

  // ─── Resolve / create Stripe Customer ───
  let customerId: string;
  try {
    customerId = await resolveStripeCustomerId(userUuidValue, user.email);
  } catch (err) {
    console.error('[refill-checkout] Customer resolution failed:', err);
    return NextResponse.json({ error: 'stripe_customer_failed' }, { status: 502 });
  }

  // ─── URLs ───
  const successPath = successUrl ?? '/dashboard/prospection?refill=success';
  const cancelPath = cancelUrl ?? '/dashboard/prospection?refill=cancel';
  const successFullUrl = getURL(successPath);
  const cancelFullUrl = getURL(cancelPath);

  // ─── Metadata pour le webhook dispatcher ───
  // `kind=refill_leads` est l'unique discriminant lu par le dispatcher
  // (lib/stripe/dispatcher.ts) pour router vers `credit-leads` au lieu de
  // `update-plan`. Les autres champs sont relayés tels quels au crédit.
  // L'email owner est inclus parce que Prospection accepte aussi l'email comme
  // tenant_id dans le path (cf src/lib/hub/tenant-lookup.ts veridian-prospection).
  const metadata = {
    kind: 'refill_leads',
    app: 'prospection',
    hub_tenant_id: tenant.id,
    owner_email: user.email,
    quantity: String(quantity),
    refill_tier: mapProspectionPlanToRefillTier(prospectionPlan),
    user_uuid: userUuidValue,
    idempotency_seed: checkoutSeedIdempotencyKey(tenant.id, quantity),
  };

  // ─── Create Stripe Checkout Session ───
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      // PAS d'`automatic_tax` ici : le refill leads est un achat de data,
      // pas un service SaaS récurrent. À aligner si la compta exige la TVA
      // (à trancher avec le comptable). Pour rester safe défaut, on ACTIVE
      // automatic_tax — cohérent avec les subs Veridian.
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
      // Duplique les metadata sur le payment_intent pour pouvoir retrouver
      // le contexte côté Stripe Dashboard / reporting (l'event
      // `payment_intent.succeeded` n'embarque pas la session.metadata).
      payment_intent_data: { metadata },
      success_url: successFullUrl,
      cancel_url: cancelFullUrl,
    });

    if (!session.url) {
      return NextResponse.json({ error: 'stripe_session_no_url' }, { status: 502 });
    }

    return NextResponse.json({
      url: session.url,
      sessionId: session.id,
      amount_cents: totalCents,
      quantity,
      tier: prospectionPlan,
    });
  } catch (err) {
    console.error('[refill-checkout] Stripe session creation failed:', err);
    return NextResponse.json(
      {
        error: 'stripe_session_failed',
        details: { message: err instanceof Error ? err.message : 'unknown' },
      },
      { status: 502 },
    );
  }
}
