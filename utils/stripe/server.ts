'use server';

import Stripe from 'stripe';
import { stripe } from '@/utils/stripe/config';
import {
  getURL,
  getErrorRedirect,
  calculateTrialEndUnixTimestamp
} from '@/utils/helpers';
import { requireUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

// Type local du Price (passé depuis Server -> Client puis re-posté en server action).
// On reste laxiste sur les champs : Stripe valide à la création.
type Price = {
  id: string;
  type?: string | null;
  trial_period_days?: number | null;
};

type CheckoutResponse = {
  errorRedirect?: string;
  sessionId?: string;
};

/**
 * Résout le Stripe customer ID associé à l'utilisateur :
 * 1. Si on en trouve un dans `subscriptions` (Prisma) -> on le réutilise.
 * 2. Sinon on cherche dans Stripe par metadata.userUuid.
 * 3. Sinon par email.
 * 4. Sinon on en crée un.
 *
 * Pas de table `customers` en local : la source de vérité est Stripe + le
 * webhook qui upsert sur `subscriptions` quand il y a une vraie souscription.
 */
async function resolveStripeCustomerId(userUuidValue: string, email: string): Promise<string> {
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
    // patch metadata pour lier ce customer à notre user (utile pour future search)
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

export async function checkoutWithStripe(
  price: Price,
  redirectPath: string = '/dashboard/billing'
): Promise<CheckoutResponse> {
  console.log('[Stripe-Checkout] Starting checkout flow:', {
    priceId: price.id,
    priceType: price.type,
    redirectPath,
    timestamp: new Date().toISOString()
  });

  try {
    // Auth.js v5
    let user;
    try {
      user = await requireUser();
    } catch {
      throw new Error('Could not get user session.');
    }
    const userUuidValue = userUuid(user);
    if (!user.email) {
      throw new Error('User has no email.');
    }

    console.log('[Stripe-Checkout] User authenticated:', {
      userId: user.id,
      userUuid: userUuidValue,
      userEmail: user.email
    });

    // Stripe customer
    let customer: string;
    try {
      customer = await resolveStripeCustomerId(userUuidValue, user.email);
      console.log('[Stripe-Checkout] Customer resolved:', customer.substring(0, 10) + '...');
    } catch (err) {
      console.error('[Stripe-Checkout] Customer resolution failed:', err);
      throw new Error('Unable to access customer record.');
    }

    // Récupérer le workspace Twenty depuis la table tenants (Prisma)
    let subscriptionMetadata: Record<string, string> = {};
    try {
      const tenant = await prisma.tenant.findFirst({
        where: { userId: userUuidValue, status: 'active' },
        select: { twentyWorkspaceId: true },
      });
      if (tenant?.twentyWorkspaceId) {
        subscriptionMetadata.workspaceId = tenant.twentyWorkspaceId;
        console.log('[Stripe-Checkout] Twenty workspace found:', tenant.twentyWorkspaceId);
      }
    } catch (err) {
      console.warn('[Stripe-Checkout] Tenant lookup failed:', err);
    }

    // Plan key depuis les metadata du product Stripe
    let trialPeriodDays: number | null | undefined = price.trial_period_days;
    try {
      const stripePrice = await stripe.prices.retrieve(price.id, {
        expand: ['product']
      });
      const product = stripePrice.product as Stripe.Product;
      const planKey = product.metadata?.planKey || 'PRO';
      subscriptionMetadata.plan = planKey;
      // Si le price embarque un trial_period_days côté Stripe, on l'utilise.
      // Sinon on garde celui passé en argument (qui peut être null).
      if (trialPeriodDays === undefined || trialPeriodDays === null) {
        trialPeriodDays = stripePrice.recurring?.trial_period_days ?? null;
      }
      console.log('[Stripe-Checkout] Plan key from product:', planKey);
    } catch (err) {
      console.warn('[Stripe-Checkout] Could not fetch product metadata, defaulting to PRO');
      subscriptionMetadata.plan = 'PRO';
    }
    subscriptionMetadata.userUuid = userUuidValue;

    let params: Stripe.Checkout.SessionCreateParams = {
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      customer,
      customer_update: {
        address: 'auto'
      },
      line_items: [
        {
          price: price.id,
          quantity: 1
        }
      ],
      cancel_url: getURL(),
      success_url: getURL(redirectPath)
    };

    console.log('[Stripe-Checkout] Trial end:', calculateTrialEndUnixTimestamp(trialPeriodDays ?? null));
    if (price.type === 'recurring') {
      params = {
        ...params,
        mode: 'subscription',
        subscription_data: {
          trial_end: calculateTrialEndUnixTimestamp(trialPeriodDays ?? null),
          metadata: subscriptionMetadata
        }
      };
    } else if (price.type === 'one_time') {
      params = {
        ...params,
        mode: 'payment'
      };
    }

    let session;
    try {
      session = await stripe.checkout.sessions.create(params);
      console.log('[Stripe-Checkout] Checkout session created:', session.id);
    } catch (err) {
      console.error('[Stripe-Checkout] Session creation failed:', err);
      throw new Error('Unable to create checkout session.');
    }

    if (session) {
      return { sessionId: session.id };
    } else {
      throw new Error('Unable to create checkout session.');
    }
  } catch (error) {
    console.error('[Stripe-Checkout] Flow failed:', error);
    if (error instanceof Error) {
      return {
        errorRedirect: getErrorRedirect(
          redirectPath,
          error.message,
          'Please try again later or contact a system administrator.'
        )
      };
    }
    return {
      errorRedirect: getErrorRedirect(
        redirectPath,
        'An unknown error occurred.',
        'Please try again later or contact a system administrator.'
      )
    };
  }
}

export async function createStripePortal(currentPath: string) {
  console.log('[Stripe-Portal] Starting portal creation:', { currentPath });

  try {
    let user;
    try {
      user = await requireUser();
    } catch {
      throw new Error('Could not get user session.');
    }
    const userUuidValue = userUuid(user);
    if (!user.email) {
      throw new Error('User has no email.');
    }

    let customer;
    try {
      customer = await resolveStripeCustomerId(userUuidValue, user.email);
      console.log('[Stripe-Portal] Customer resolved:', customer.substring(0, 10) + '...');
    } catch (err) {
      console.error('[Stripe-Portal] Customer resolution failed:', err);
      throw new Error('Unable to access customer record.');
    }

    if (!customer) {
      throw new Error('Could not get customer.');
    }

    try {
      const { url } = await stripe.billingPortal.sessions.create({
        customer,
        return_url: getURL('/dashboard/billing')
      });
      if (!url) {
        throw new Error('Could not create billing portal');
      }
      return url;
    } catch (err) {
      console.error('[Stripe-Portal] Portal creation failed:', err);
      throw new Error('Could not create billing portal');
    }
  } catch (error) {
    console.error('[Stripe-Portal] Flow failed:', error);
    if (error instanceof Error) {
      return getErrorRedirect(
        currentPath,
        error.message,
        'Please try again later or contact a system administrator.'
      );
    }
    return getErrorRedirect(
      currentPath,
      'An unknown error occurred.',
      'Please try again later or contact a system administrator.'
    );
  }
}
