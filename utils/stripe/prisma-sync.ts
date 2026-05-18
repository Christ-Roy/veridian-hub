// utils/stripe/prisma-sync.ts
//
// Helpers Prisma pour le webhook Stripe.
//
// Architecture post-refactor 2026-05-18 :
// - Stripe reste source de vérité pour l'ÉTAT des subscriptions (active/canceled,
//   trial_end, current_period_end). On sync ça dans `hub_app.subscriptions`.
// - Le CATALOGUE de plans vit dans lib/pricing/plans.ts (versionné). Plus de
//   table products/prices à maintenir — les fonctions upsert*/delete*
//   correspondantes ont été dégagées.
// - La mapping `stripe_price_id` → `PlanKey` passe par
//   getPlanByStripePriceId() qui regarde le catalogue ET le mapping legacy.

import Stripe from 'stripe';

import { prisma } from '@/lib/prisma';
import { stripe } from '@/utils/stripe/config';
import { toDateTime } from '@/utils/helpers';
import { getPlanByStripePriceId, getAppPlansForBundle } from '@/lib/pricing/helpers';

/**
 * Résout le user UUID Hub lié à un Stripe customer ID.
 * Ordre :
 *  1. Existing Subscription avec ce stripeCustomerId
 *  2. Stripe customer metadata `userUuid` / `supabaseUUID` (legacy)
 *  3. Stripe customer email → User.supabaseUserId via lookup par email
 */
async function resolveUserUuid(customerId: string): Promise<string> {
  const existingSub = await prisma.subscription.findFirst({
    where: { stripeCustomerId: customerId },
    select: { userId: true },
  });
  if (existingSub?.userId) return existingSub.userId;

  const stripeCustomer = await stripe.customers.retrieve(customerId);
  if ('deleted' in stripeCustomer && stripeCustomer.deleted) {
    throw new Error(`Stripe customer ${customerId} was deleted`);
  }

  const metadataUuid =
    (stripeCustomer.metadata?.userUuid as string | undefined) ??
    (stripeCustomer.metadata?.supabaseUUID as string | undefined) ??
    (stripeCustomer.metadata?.supabase_uuid as string | undefined);
  if (metadataUuid) return metadataUuid;

  const email = stripeCustomer.email;
  if (!email) {
    throw new Error(`Customer ${customerId} has no email and no metadata UUID`);
  }
  const user = await prisma.user.findUnique({
    where: { email },
    select: { supabaseUserId: true },
  });
  if (!user?.supabaseUserId) {
    throw new Error(
      `Cannot resolve UUID for customer ${customerId} (email ${email}) — no User found`,
    );
  }
  return user.supabaseUserId;
}

/**
 * Sync de l'état Stripe → DB Hub pour une subscription, et propagation des
 * plans aux apps downstream concernées (notifuse, prospection) via le mapping
 * catalogue.
 *
 * Appelé par le webhook Stripe sur les events :
 *  - customer.subscription.created
 *  - customer.subscription.updated
 *  - customer.subscription.deleted
 *  - checkout.session.completed (via subscriptionId)
 */
export async function manageSubscriptionStatusChange(
  subscriptionId: string,
  customerId: string,
  _createAction = false,
): Promise<void> {
  const uuid = await resolveUserUuid(customerId);

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method'],
  });

  const stripePriceId = subscription.items.data[0]?.price.id ?? null;
  const isActive = ['active', 'trialing'].includes(subscription.status);

  // ─── Lookup PlanKey depuis le catalogue ───
  // Priorité 1 : metadata `plan_key` qu'on a posée lors du checkout
  // (cf app/api/billing/checkout/route.ts). Source de vérité explicite.
  // Priorité 2 : mapping stripe_price_id → PlanKey via catalogue + legacy.
  let planKey: string | null =
    (subscription.metadata?.plan_key as string | undefined) ?? null;

  if (!planKey && stripePriceId) {
    const planFromPriceId = getPlanByStripePriceId(stripePriceId);
    if (planFromPriceId) {
      planKey = planFromPriceId.key;
    } else {
      console.warn(
        `[stripe-sync] Unknown stripe_price_id ${stripePriceId} for sub ${subscription.id} ` +
          `— add it to LEGACY_STRIPE_PRICE_MAPPING in lib/pricing/plans.ts`,
      );
    }
  }

  // ─── Sync subscription state ───
  const data = {
    userId: uuid,
    stripeCustomerId: subscription.customer as string,
    stripeSubscriptionId: subscription.id,
    stripePriceId,
    priceId: stripePriceId,
    status: subscription.status as
      | 'trialing'
      | 'active'
      | 'past_due'
      | 'canceled'
      | 'incomplete'
      | 'incomplete_expired'
      | 'unpaid',
    metadata: (subscription.metadata ?? {}) as object,
    planName: planKey, // 🔥 Catalogue PlanKey, source de vérité côté Hub
    quantity:
      typeof (subscription as unknown as { quantity?: number }).quantity === 'number'
        ? (subscription as unknown as { quantity: number }).quantity
        : 1,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: subscription.cancel_at ? toDateTime(subscription.cancel_at) : null,
    canceledAt: subscription.canceled_at ? toDateTime(subscription.canceled_at) : null,
    currentPeriodStart: toDateTime(subscription.current_period_start),
    currentPeriodEnd: toDateTime(subscription.current_period_end),
    created: toDateTime(subscription.created),
    endedAt: subscription.ended_at ? toDateTime(subscription.ended_at) : null,
    trialStart: subscription.trial_start ? toDateTime(subscription.trial_start) : null,
    trialEnd: subscription.trial_end ? toDateTime(subscription.trial_end) : null,
  };

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: subscription.id },
    create: data,
    update: data,
  });

  // ─── Propagation aux apps downstream via mapping catalogue ───
  // Cf docs/CONTRAT-HUB.md §7.4 (chaîne Stripe → Hub → apps).
  if (planKey) {
    try {
      const tenant = await prisma.tenant.findFirst({
        where: { userId: uuid },
        select: { id: true, notifusePlan: true, prospectionPlan: true, metadata: true },
      });

      if (tenant) {
        // Plans actifs → applique le bundle. Inactifs → on retombe sur free.
        const appPlans = isActive
          ? getAppPlansForBundle(planKey as Parameters<typeof getAppPlansForBundle>[0])
          : [];

        // Default conservateur : si subscription inactive, downgrade aux plans free.
        // ATTENTION : ne JAMAIS toucher un tenant avec plan_source ∈ lifetime_*/internal
        // (cf §3.3 contrat — immunité Stripe). On vérifie via metadata.
        const meta = (tenant.metadata as Record<string, unknown> | null) ?? {};
        const notifusePlanSource =
          (meta.notifuse_plan_source as string | undefined) ?? 'manual';
        const isImmuneNotifuse = ['lifetime_site_vitrine', 'lifetime_partner', 'internal'].includes(
          notifusePlanSource,
        );

        const targetNotifuse = isImmuneNotifuse
          ? tenant.notifusePlan
          : isActive
            ? appPlans.find((p) => p.app === 'notifuse')?.plan?.replace(/^notifuse-/, '') ?? 'free'
            : 'free';

        const targetProspection = isActive
          ? appPlans.find((p) => p.app === 'prospection')?.plan?.replace(/^prospection-/, '') ?? 'freemium'
          : 'freemium';

        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            notifusePlan: targetNotifuse,
            prospectionPlan: targetProspection,
          },
        });

        console.log(
          `[stripe-sync] Tenant ${tenant.id} updated: notifuse=${targetNotifuse}, prospection=${targetProspection} ` +
            `(planKey=${planKey}, isActive=${isActive}, immune=${isImmuneNotifuse})`,
        );

        // TODO §7.4 : propagation HMAC vers les apps downstream via
        // `/api/tenants/update-plan`. Aujourd'hui DB-only (warning explicite
        // côté admin endpoint). À câbler dans une session dédiée — non
        // bloquant car les apps ont leur propre sync via lecture DB Hub.
      }
    } catch (syncErr) {
      console.error(
        `[stripe-sync] Failed to propagate plan to tenant for user ${uuid} (non-blocking):`,
        syncErr,
      );
    }
  }
}
