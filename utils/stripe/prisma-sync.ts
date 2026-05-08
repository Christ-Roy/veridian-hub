// Helpers Prisma pour le webhook Stripe — porte la logique de
// `utils/supabase/admin.ts` (upsertProductRecord, upsertPriceRecord,
// manageSubscriptionStatusChange) vers Prisma + hub_app.
//
// Source de vérité : Stripe. La DB ne fait que mirror.
//
// Customer mapping : l'ancien schema avait une table `customers` (id UUID →
// stripe_customer_id). Le nouveau schema n'a pas cette table — on retrouve
// l'utilisateur via :
//  1. `Subscription.findFirst({ where: { stripeCustomerId } })` (cas le plus
//     fréquent — la sub existe déjà chez nous)
//  2. `stripeCustomer.metadata.supabaseUUID` (set lors du createOrRetrieveCustomer)
//  3. `Profile.findUnique({ where: { email } })` (fallback par email)

import Stripe from 'stripe';

import { prisma } from '@/lib/prisma';
import { stripe } from '@/utils/stripe/config';
import { toDateTime } from '@/utils/helpers';

const TRIAL_PERIOD_DAYS = 0;

export async function upsertProductRecord(product: Stripe.Product): Promise<void> {
  console.log(`[Admin] Upserting product ${product.id}:`, {
    name: product.name,
    active: product.active,
  });

  const data = {
    id: product.id,
    active: product.active,
    name: product.name,
    description: product.description ?? null,
    image: product.images?.[0] ?? null,
    metadata: (product.metadata ?? {}) as object,
  };

  try {
    await prisma.product.upsert({
      where: { id: product.id },
      create: data,
      update: data,
    });
    console.log(`[Admin] ✅ Product ${product.id} upserted successfully`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.error(`[Admin] Product upsert failed (${product.id}):`, message);
    throw new Error(`Product insert/update failed: ${message}`);
  }
}

export async function upsertPriceRecord(
  price: Stripe.Price,
  retryCount = 0,
  maxRetries = 3,
): Promise<void> {
  console.log(`[Admin] Upserting price ${price.id} (retry ${retryCount}/${maxRetries})`);

  const data = {
    id: price.id,
    productId: typeof price.product === 'string' ? price.product : null,
    active: price.active,
    currency: price.currency,
    description: price.nickname ?? null,
    type: price.type as 'one_time' | 'recurring',
    unitAmount: price.unit_amount != null ? BigInt(price.unit_amount) : null,
    interval: (price.recurring?.interval ?? null) as
      | 'day'
      | 'week'
      | 'month'
      | 'year'
      | null,
    intervalCount: price.recurring?.interval_count ?? null,
    trialPeriodDays: price.recurring?.trial_period_days ?? TRIAL_PERIOD_DAYS,
    metadata: ({
      ...(price.metadata || {}),
      lookup_key: price.lookup_key || null,
    } as unknown) as object,
  };

  try {
    await prisma.price.upsert({
      where: { id: price.id },
      create: data,
      update: data,
    });
    console.log(`[Admin] ✅ Price ${price.id} upserted successfully`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (message.includes('foreign key') || message.toLowerCase().includes('foreign')) {
      console.warn(`[Admin] FK constraint error for price ${price.id}, retrying...`);
      if (retryCount < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await upsertPriceRecord(price, retryCount + 1, maxRetries);
        return;
      }
    }
    console.error(`[Admin] Price upsert failed (${price.id}):`, message);
    throw new Error(`Price insert/update failed: ${message}`);
  }
}

export async function deleteProductRecord(product: Stripe.Product): Promise<void> {
  try {
    await prisma.product.delete({ where: { id: product.id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    // Ignore "not found" — already deleted
    if (!message.includes('not found') && !message.includes('Record to delete')) {
      console.error(`[Admin] Product deletion failed (${product.id}):`, message);
      throw new Error(`Product deletion failed: ${message}`);
    }
  }
}

export async function deletePriceRecord(price: Stripe.Price): Promise<void> {
  try {
    await prisma.price.delete({ where: { id: price.id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (!message.includes('not found') && !message.includes('Record to delete')) {
      console.error(`[Admin] Price deletion failed (${price.id}):`, message);
      throw new Error(`Price deletion failed: ${message}`);
    }
  }
}

/**
 * Resolve the user UUID linked to a Stripe customer.
 * Order of resolution :
 *  1. Existing Subscription with this stripeCustomerId
 *  2. Stripe customer metadata `supabaseUUID` / `supabase_uuid`
 *  3. Stripe customer email → User.supabaseUserId via User by email
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

export async function manageSubscriptionStatusChange(
  subscriptionId: string,
  customerId: string,
  _createAction = false,
): Promise<void> {
  const uuid = await resolveUserUuid(customerId);

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method'],
  });

  const priceId = subscription.items.data[0]?.price.id ?? null;

  const data = {
    userId: uuid,
    stripeCustomerId: subscription.customer as string,
    stripeSubscriptionId: subscription.id,
    stripePriceId: priceId,
    priceId,
    status: subscription.status as
      | 'trialing'
      | 'active'
      | 'past_due'
      | 'canceled'
      | 'incomplete'
      | 'incomplete_expired'
      | 'unpaid',
    metadata: (subscription.metadata ?? {}) as object,
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

  // Upsert by stripeSubscriptionId (unique)
  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: subscription.id },
    create: data,
    update: data,
  });

  // Sync prospection plan based on Stripe subscription status
  try {
    if (priceId) {
      const price = await prisma.price.findUnique({
        where: { id: priceId },
        select: { productId: true },
      });

      if (price?.productId) {
        const product = await prisma.product.findUnique({
          where: { id: price.productId },
          select: { metadata: true },
        });

        const planKey = (product?.metadata as Record<string, string> | null)?.planKey;
        const isActive = ['active', 'trialing'].includes(subscription.status);
        const prospectionPlan = isActive
          ? planKey === 'ENTERPRISE'
            ? 'enterprise'
            : planKey === 'PRO'
              ? 'pro'
              : 'freemium'
          : 'freemium';

        await prisma.tenant.updateMany({
          where: { userId: uuid },
          data: { prospectionPlan },
        });

        console.log(
          `[Admin] Synced prospection_plan=${prospectionPlan} for user ${uuid} (stripe status: ${subscription.status}, planKey: ${planKey})`,
        );
      }
    }
  } catch (syncErr) {
    const message = syncErr instanceof Error ? syncErr.message : 'unknown';
    console.error(`[Admin] Failed to sync prospection_plan (non-blocking):`, message);
  }
}
