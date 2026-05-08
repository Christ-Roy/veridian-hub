/**
 * GET /api/account/recent-subscription
 *
 * Retourne la subscription la plus récente du user authentifié, sérialisée
 * pour le client (BigInt -> Number). Utilisé par PurchaseTracker pour
 * détecter un purchase juste après un checkout Stripe et fire l'event GA4.
 */

import { NextResponse } from 'next/server';
import { requireUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }

  let userUuidValue: string;
  try {
    userUuidValue = userUuid(user);
  } catch {
    return NextResponse.json({ subscription: null });
  }

  const subscription = await prisma.subscription.findFirst({
    where: { userId: userUuidValue },
    orderBy: { createdAt: 'desc' },
    include: {
      price: {
        include: { product: true },
      },
    },
  });

  if (!subscription) {
    return NextResponse.json({ subscription: null });
  }

  // Sérialisation BigInt -> Number
  const payload = {
    id: subscription.id,
    status: subscription.status,
    stripe_subscription_id: subscription.stripeSubscriptionId,
    stripe_price_id: subscription.stripePriceId,
    created_at: subscription.createdAt?.toISOString() ?? null,
    created: subscription.created?.toISOString() ?? null,
    prices: subscription.price
      ? {
          id: subscription.price.id,
          unit_amount:
            subscription.price.unitAmount === null
              ? null
              : Number(subscription.price.unitAmount),
          currency: subscription.price.currency,
          product_id: subscription.price.productId,
          products: subscription.price.product
            ? {
                id: subscription.price.product.id,
                name: subscription.price.product.name,
              }
            : null,
        }
      : null,
  };

  return NextResponse.json({ subscription: payload });
}
