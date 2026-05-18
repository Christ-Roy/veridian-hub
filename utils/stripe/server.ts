'use server';

import { stripe } from '@/utils/stripe/config';
import { getURL, getErrorRedirect } from '@/utils/helpers';
import { requireUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

/**
 * Résout le Stripe customer ID associé à l'utilisateur :
 * 1. Si on en trouve un dans `subscriptions` (Prisma) → on le réutilise.
 * 2. Sinon on cherche dans Stripe par metadata.userUuid.
 * 3. Sinon par email.
 * 4. Sinon on en crée un.
 *
 * Pas de table `customers` en local : la source de vérité est Stripe + le
 * webhook qui upsert sur `subscriptions` quand il y a une vraie souscription.
 *
 * Exporté pour réutilisation par `app/api/billing/checkout/route.ts`.
 */
export async function resolveStripeCustomerId(
  userUuidValue: string,
  email: string,
): Promise<string> {
  // 1) Existing subscription in our DB
  const existing = await prisma.subscription.findFirst({
    where: { userId: userUuidValue },
    select: { stripeCustomerId: true },
  });
  if (existing?.stripeCustomerId) {
    return existing.stripeCustomerId;
  }

  // 2) Stripe customers by metadata.userUuid
  const byMetadata = await stripe.customers.search({
    query: `metadata['userUuid']:'${userUuidValue}'`,
    limit: 1,
  });
  if (byMetadata.data[0]?.id) {
    return byMetadata.data[0].id;
  }

  // 3) Stripe customers by email
  const byEmail = await stripe.customers.list({ email, limit: 1 });
  if (byEmail.data[0]?.id) {
    try {
      await stripe.customers.update(byEmail.data[0].id, {
        metadata: { ...(byEmail.data[0].metadata ?? {}), userUuid: userUuidValue },
      });
    } catch (e) {
      console.warn('[Stripe-Customer] could not patch metadata:', e);
    }
    return byEmail.data[0].id;
  }

  // 4) Create
  const created = await stripe.customers.create({
    email,
    metadata: { userUuid: userUuidValue },
  });
  return created.id;
}

/**
 * Crée une session Stripe Billing Portal pour le user authentifié.
 * Retourne l'URL absolue ou une URL d'erreur Hub.
 */
export async function createStripePortal(currentPath: string): Promise<string> {
  try {
    const user = await requireUser();
    const userUuidValue = userUuid(user);
    if (!user.email) {
      throw new Error('User has no email.');
    }

    const customer = await resolveStripeCustomerId(userUuidValue, user.email);

    const { url } = await stripe.billingPortal.sessions.create({
      customer,
      return_url: getURL('/dashboard/billing'),
    });
    if (!url) {
      throw new Error('Could not create billing portal');
    }
    return url;
  } catch (error) {
    console.error('[Stripe-Portal] Flow failed:', error);
    const msg = error instanceof Error ? error.message : 'An unknown error occurred.';
    return getErrorRedirect(currentPath, msg, 'Please try again later or contact support.');
  }
}
