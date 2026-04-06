'use server';

import Stripe from 'stripe';
import { stripe } from '@/utils/stripe/config';
import { createClient } from '@/utils/supabase/server';
import { createOrRetrieveCustomer } from '@/utils/supabase/admin';
import {
  getURL,
  getErrorRedirect,
  calculateTrialEndUnixTimestamp
} from '@/utils/helpers';
import { Tables } from '@/types_db';

type Price = Tables<'prices'>;

type CheckoutResponse = {
  errorRedirect?: string;
  sessionId?: string;
};

export async function checkoutWithStripe(
  price: Price,
  redirectPath: string = '/dashboard/billing'
): Promise<CheckoutResponse> {
  console.log('[Stripe-Checkout] 🛒 Starting checkout flow:', {
    priceId: price.id,
    priceAmount: price.unit_amount,
    priceCurrency: price.currency,
    priceType: price.type,
    interval: price.interval,
    redirectPath,
    timestamp: new Date().toISOString()
  });

  try {
    // Get the user from Supabase auth
    const supabase = createClient();
    const {
      error,
      data: { user }
    } = await supabase.auth.getUser();

    if (error || !user) {
      console.error('[Stripe-Checkout] ❌ User lookup failed:', {
        error: error?.message,
        hasUser: !!user
      });
      throw new Error('Could not get user session.');
    }

    console.log('[Stripe-Checkout] ✅ User authenticated:', {
      userId: user.id,
      userEmail: user.email
    });

    // Retrieve or create the customer in Stripe
    let customer: string;
    try {
      customer = await createOrRetrieveCustomer({
        uuid: user?.id || '',
        email: user?.email || ''
      });
      console.log('[Stripe-Checkout] ✅ Customer retrieved/created:', customer.substring(0, 10) + '...');
    } catch (err) {
      console.error('[Stripe-Checkout] ❌ Customer retrieval failed:', err);
      throw new Error('Unable to access customer record.');
    }

    // Récupérer le workspace Twenty depuis la table tenants
    let subscriptionMetadata: Record<string, string> = {};
    try {
      const { data: tenant, error: tenantError } = await supabase
        .from('tenants')
        .select('twenty_workspace_id')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();

      // Cast explicite car types_db n'a pas twenty_workspace_id
      const tenantData = tenant as any;

      if (tenantError) {
        console.warn('[Stripe-Checkout] ⚠️ Could not fetch tenant:', tenantError);
      } else if (tenantData?.twenty_workspace_id) {
        subscriptionMetadata.workspaceId = tenantData.twenty_workspace_id;
        console.log('[Stripe-Checkout] ✅ Twenty workspace found:', tenantData.twenty_workspace_id);
      }
    } catch (err) {
      console.warn('[Stripe-Checkout] ⚠️ Tenant lookup failed:', err);
    }

    // Déterminer le plan key depuis les metadata du produit Stripe
    try {
      const stripePrice = await stripe.prices.retrieve(price.id, {
        expand: ['product']
      });
      const product = stripePrice.product as Stripe.Product;
      const planKey = product.metadata?.planKey || 'PRO';
      subscriptionMetadata.plan = planKey;
      console.log('[Stripe-Checkout] ✅ Plan key from product:', planKey);
    } catch (err) {
      console.warn('[Stripe-Checkout] ⚠️ Could not fetch product metadata, defaulting to PRO');
      subscriptionMetadata.plan = 'PRO';
    }

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

    console.log('[Stripe-Checkout] 📦 Checkout session params:', {
      customer: customer.substring(0, 10) + '...',
      cancel_url: params.cancel_url,
      success_url: params.success_url,
      lineItemsCount: params.line_items?.length,
      metadata: subscriptionMetadata
    });

    console.log(
      'Trial end:',
      calculateTrialEndUnixTimestamp(price.trial_period_days)
    );
    if (price.type === 'recurring') {
      params = {
        ...params,
        mode: 'subscription',
        subscription_data: {
          trial_end: calculateTrialEndUnixTimestamp(price.trial_period_days),
          metadata: subscriptionMetadata
        }
      };
      console.log('[Stripe-Checkout] 🔄 Subscription mode with trial');
    } else if (price.type === 'one_time') {
      params = {
        ...params,
        mode: 'payment'
      };
      console.log('[Stripe-Checkout] 💳 One-time payment mode');
    }

    // Create a checkout session in Stripe
    let session;
    try {
      console.log('[Stripe-Checkout] 🎫 Creating Stripe checkout session...');
      session = await stripe.checkout.sessions.create(params);
      console.log('[Stripe-Checkout] ✅ Checkout session created:', {
        sessionId: session.id.substring(0, 10) + '...',
        url: session.url
      });
    } catch (err) {
      console.error('[Stripe-Checkout] ❌ Session creation failed:', err);
      throw new Error('Unable to create checkout session.');
    }

    // Instead of returning a Response, just return the data or error.
    if (session) {
      console.log('[Stripe-Checkout] ✅ Flow completed successfully');
      return { sessionId: session.id };
    } else {
      console.error('[Stripe-Checkout] ❌ No session returned');
      throw new Error('Unable to create checkout session.');
    }
  } catch (error) {
    console.error('[Stripe-Checkout] ❌ Flow failed with error:', error);
    if (error instanceof Error) {
      return {
        errorRedirect: getErrorRedirect(
          redirectPath,
          error.message,
          'Please try again later or contact a system administrator.'
        )
      };
    } else {
      return {
        errorRedirect: getErrorRedirect(
          redirectPath,
          'An unknown error occurred.',
          'Please try again later or contact a system administrator.'
        )
      };
    }
  }
}

export async function createStripePortal(currentPath: string) {
  console.log('[Stripe-Portal] 🚪 Starting portal creation:', {
    currentPath,
    timestamp: new Date().toISOString()
  });

  try {
    const supabase = createClient();
    const {
      error,
      data: { user }
    } = await supabase.auth.getUser();

    if (!user) {
      console.error('[Stripe-Portal] ❌ User lookup failed:', {
        error: error?.message,
        hasUser: !!user
      });
      if (error) {
        console.error(error);
      }
      throw new Error('Could not get user session.');
    }

    console.log('[Stripe-Portal] ✅ User authenticated:', {
      userId: user.id,
      userEmail: user.email
    });

    let customer;
    try {
      customer = await createOrRetrieveCustomer({
        uuid: user.id || '',
        email: user.email || ''
      });
      console.log('[Stripe-Portal] ✅ Customer retrieved:', customer.substring(0, 10) + '...');
    } catch (err) {
      console.error('[Stripe-Portal] ❌ Customer retrieval failed:', err);
      throw new Error('Unable to access customer record.');
    }

    if (!customer) {
      console.error('[Stripe-Portal] ❌ No customer returned');
      throw new Error('Could not get customer.');
    }

    try {
      console.log('[Stripe-Portal] 🎨 Creating billing portal session...');
      const { url } = await stripe.billingPortal.sessions.create({
        customer,
        return_url: getURL('/dashboard/billing')
      });
      if (!url) {
        console.error('[Stripe-Portal] ❌ No URL returned');
        throw new Error('Could not create billing portal');
      }
      console.log('[Stripe-Portal] ✅ Portal created successfully:', {
        url: url.substring(0, 50) + '...'
      });
      return url;
    } catch (err) {
      console.error('[Stripe-Portal] ❌ Portal creation failed:', err);
      throw new Error('Could not create billing portal');
    }
  } catch (error) {
    console.error('[Stripe-Portal] ❌ Flow failed with error:', error);
    if (error instanceof Error) {
      console.error(error);
      return getErrorRedirect(
        currentPath,
        error.message,
        'Please try again later or contact a system administrator.'
      );
    } else {
      return getErrorRedirect(
        currentPath,
        'An unknown error occurred.',
        'Please try again later or contact a system administrator.'
      );
    }
  }
}
