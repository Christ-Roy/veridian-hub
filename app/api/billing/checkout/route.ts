// POST /api/billing/checkout
//
// Crée une Stripe Checkout Session pour un user authentifié, à partir d'une
// clé de plan du catalogue lib/pricing/plans.ts.
//
// Body : { plan: PlanKey, interval: "month" | "year", redirect?: string }
// Response 200 : { url: string } → le front fait window.location = data.url
// Response 4xx : { error, details? }

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUser, userUuid } from '@/lib/auth/get-user';
import { stripe } from '@/utils/stripe/config';
import { resolveStripeCustomerId } from '@/utils/stripe/server';
import { tryGetPlanByKey, getStripePriceIdForCheckout } from '@/lib/pricing/helpers';
import { getURL } from '@/utils/helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  plan: z.string().min(1),
  interval: z.enum(['month', 'year']).default('month'),
  redirect: z.string().optional(),
});

export async function POST(request: NextRequest) {
  // Auth
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

  // Body
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

  const { plan: planKey, interval, redirect } = parsed.data;

  // Plan lookup
  const plan = tryGetPlanByKey(planKey);
  if (!plan) {
    return NextResponse.json({ error: 'unknown_plan', details: { plan: planKey } }, { status: 400 });
  }

  // Ordre : on check `plan_source` AVANT `price_eur` car un lifetime_* peut
  // avoir price_eur=0 mais l'erreur sémantiquement correcte est "non-payable",
  // pas "free".
  if (plan.plan_source !== 'stripe') {
    return NextResponse.json(
      { error: 'plan_not_payable', details: { hint: 'Plans offerts (lifetime_*, internal) ne passent pas par Stripe' } },
      { status: 400 },
    );
  }

  if (plan.price_eur === 0) {
    return NextResponse.json(
      { error: 'plan_is_free', details: { hint: 'Pas de checkout nécessaire — provisionner via /api/tenants/start' } },
      { status: 400 },
    );
  }

  // Resolve Stripe price ID (peut throw si placeholder pas rempli)
  let stripePriceId: string;
  try {
    stripePriceId = getStripePriceIdForCheckout(plan.key, interval);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'price not configured';
    console.error('[checkout] Plan has no Stripe Price ID:', msg);
    return NextResponse.json(
      { error: 'stripe_price_not_configured', details: { plan: plan.key, interval, hint: msg } },
      { status: 503 },
    );
  }

  // Resolve customer
  const userUuidValue = userUuid(user);
  let customerId: string;
  try {
    customerId = await resolveStripeCustomerId(userUuidValue, user.email);
  } catch (err) {
    console.error('[checkout] Customer resolution failed:', err);
    return NextResponse.json({ error: 'stripe_customer_failed' }, { status: 502 });
  }

  // Build success/cancel URLs
  const successRedirect = redirect && redirect.startsWith('/')
    ? redirect
    : '/dashboard/billing?checkout=success';
  const successUrl = getURL(successRedirect);
  const cancelUrl = getURL('/pricing?canceled=1');

  // Détermine les apps cibles du plan (un bundle en touche 2). Posée en
  // metadata pour que le dispatcher webhook route le `update-plan` sans
  // re-dériver le bundle. Cohérent avec CONTRAT-BILLING.md §8.2 (`metadata.app`).
  const appTarget =
    plan.apps.length > 1 ? 'bundle' : (plan.apps[0] ?? 'unknown');

  // Create checkout session
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: stripePriceId, quantity: 1 }],
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      // automatic_tax : Stripe Tax collecte la TVA selon le pays du client
      // (décision Robert figée 2026-05-22 — vendre du SaaS en UE = TVA
      // obligatoire). `customer_update.name` est requis par Stripe Tax pour
      // pouvoir rattacher l'adresse au Customer.
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
      subscription_data: {
        metadata: {
          // 🔥 Source de vérité de la PlanKey côté Hub. Le webhook
          // checkout.session.completed lira cette metadata pour propager le
          // plan aux apps downstream (cf docs/CONTRAT-BILLING.md §8.2).
          plan_key: plan.key,
          user_uuid: userUuidValue,
          // Routage du dispatch : `notifuse` | `prospection` | `bundle`.
          app: appTarget,
        },
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    if (!session.url) {
      return NextResponse.json({ error: 'stripe_session_no_url' }, { status: 502 });
    }

    return NextResponse.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('[checkout] Stripe session creation failed:', err);
    return NextResponse.json(
      { error: 'stripe_session_failed', details: { message: err instanceof Error ? err.message : 'unknown' } },
      { status: 502 },
    );
  }
}
