// @ts-nocheck
import { toDateTime } from '@/utils/helpers';
import { stripe } from '@/utils/stripe/config';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import type { Database, Tables, TablesInsert } from 'types_db';

type Product = Tables<'products'>;
type Price = Tables<'prices'>;

// Change to control trial period length
const TRIAL_PERIOD_DAYS = 0;

// Note: supabaseAdmin uses the SERVICE_ROLE_KEY which you must only use in a secure server-side context
// as it has admin privileges and overwrites RLS policies!
// Lazy initialization to avoid errors during build time
let supabaseAdmin: ReturnType<typeof createClient<Database>> | null = null;

function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    // Use internal Docker URL if available (for server-side), fallback to public URL
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error('[Admin] Missing Supabase credentials');
      throw new Error('Missing Supabase credentials (SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)');
    }

    supabaseAdmin = createClient<Database>(supabaseUrl, supabaseKey);
  }
  return supabaseAdmin;
}

const upsertProductRecord = async (product: Stripe.Product) => {
  console.log(`[Admin] Upserting product ${product.id}:`, { name: product.name, active: product.active });

  const productData: Product = {
    id: product.id,
    active: product.active,
    name: product.name,
    description: product.description ?? null,
    image: product.images?.[0] ?? null,
    metadata: product.metadata
  };

  console.log(`[Admin] Product data:`, JSON.stringify(productData).substring(0, 200) + '...');

  const { error: upsertError } = await getSupabaseAdmin()
    .from('products')
    .upsert([productData]);

  if (upsertError) {
    console.error(`[Admin] Product upsert failed (${product.id}):`, upsertError.message);
    console.error(`[Admin] Full error:`, upsertError);
    throw new Error(`Product insert/update failed: ${upsertError.message}`);
  }

  console.log(`[Admin] ✅ Product ${product.id} upserted successfully`);
};

const upsertPriceRecord = async (
  price: Stripe.Price,
  retryCount = 0,
  maxRetries = 3
) => {
  console.log(`[Admin] Upserting price ${price.id} (retry ${retryCount}/${maxRetries}):`, {
    product_id: typeof price.product === 'string' ? price.product : '',
    unit_amount: price.unit_amount,
    interval: price.recurring?.interval,
    lookup_key: price.lookup_key
  });

  const priceData: any = {
    id: price.id,
    product_id: typeof price.product === 'string' ? price.product : '',
    active: price.active,
    currency: price.currency,
    description: price.nickname ?? null,
    type: price.type,
    unit_amount: price.unit_amount ?? null,
    interval: price.recurring?.interval ?? null,
    interval_count: price.recurring?.interval_count ?? null,
    trial_period_days: price.recurring?.trial_period_days ?? TRIAL_PERIOD_DAYS,
    metadata: {
      ...(price.metadata || {}),
      lookup_key: price.lookup_key || null
    }
  };

  console.log(`[Admin] Price data:`, JSON.stringify(priceData).substring(0, 200) + '...');

  const { error: upsertError } = await getSupabaseAdmin()
    .from('prices')
    .upsert([priceData]);

  if (upsertError?.message.includes('foreign key constraint')) {
    console.warn(`[Admin] Foreign key constraint error for price ${price.id}, retrying...`);
    if (retryCount < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await upsertPriceRecord(price, retryCount + 1, maxRetries);
    } else {
      console.error(`[Admin] Price upsert failed after ${maxRetries} retries (${price.id}):`, upsertError.message);
      console.error(`[Admin] Full error:`, upsertError);
      throw new Error(
        `Price insert/update failed after ${maxRetries} retries: ${upsertError.message}`
      );
    }
  } else if (upsertError) {
    console.error(`[Admin] Price upsert failed (${price.id}):`, upsertError.message);
    console.error(`[Admin] Full error:`, upsertError);
    throw new Error(`Price insert/update failed: ${upsertError.message}`);
  }

  console.log(`[Admin] ✅ Price ${price.id} upserted successfully`);
};

const deleteProductRecord = async (product: Stripe.Product) => {
  const { error: deletionError } = await getSupabaseAdmin()
    .from('products')
    .delete()
    .eq('id', product.id);
  if (deletionError) {
    console.error(`[Admin] Product deletion failed (${product.id}):`, deletionError.message);
    throw new Error(`Product deletion failed: ${deletionError.message}`);
  }
};

const deletePriceRecord = async (price: Stripe.Price) => {
  const { error: deletionError } = await getSupabaseAdmin()
    .from('prices')
    .delete()
    .eq('id', price.id);
  if (deletionError) {
    console.error(`[Admin] Price deletion failed (${price.id}):`, deletionError.message);
    throw new Error(`Price deletion failed: ${deletionError.message}`);
  }
};

const upsertCustomerToSupabase = async (uuid: string, customerId: string) => {
  const { error: upsertError } = await getSupabaseAdmin()
    .from('customers')
    .upsert([{ id: uuid, stripe_customer_id: customerId }]);

  if (upsertError)
    throw new Error(`Supabase customer record creation failed: ${upsertError.message}`);

  return customerId;
};

const createCustomerInStripe = async (uuid: string, email: string) => {
  const customerData = { metadata: { supabaseUUID: uuid }, email: email };
  const newCustomer = await stripe.customers.create(customerData);
  if (!newCustomer) throw new Error('Stripe customer creation failed.');

  return newCustomer.id;
};

const createOrRetrieveCustomer = async ({
  email,
  uuid
}: {
  email: string;
  uuid: string;
}) => {
  // Check if the customer already exists in Supabase
  const { data: existingSupabaseCustomer, error: queryError } =
    await getSupabaseAdmin()
      .from('customers')
      .select('*')
      .eq('id', uuid)
      .maybeSingle();

  if (queryError) {
    console.error('[Admin] Customer lookup failed:', queryError.message);
    throw new Error(`Supabase customer lookup failed: ${queryError.message}`);
  }

  // Retrieve the Stripe customer ID using the Supabase customer ID, with email fallback
  let stripeCustomerId: string | undefined;
  if (existingSupabaseCustomer?.stripe_customer_id) {
    const existingStripeCustomer = await stripe.customers.retrieve(
      existingSupabaseCustomer.stripe_customer_id
    );
    stripeCustomerId = existingStripeCustomer.id;
  } else {
    // If Stripe ID is missing from Supabase, try to retrieve Stripe customer ID by email
    const stripeCustomers = await stripe.customers.list({ email: email });
    stripeCustomerId =
      stripeCustomers.data.length > 0 ? stripeCustomers.data[0].id : undefined;
  }

  // If still no stripeCustomerId, create a new customer in Stripe
  const stripeIdToInsert = stripeCustomerId
    ? stripeCustomerId
    : await createCustomerInStripe(uuid, email);
  if (!stripeIdToInsert) throw new Error('Stripe customer creation failed.');

  if (existingSupabaseCustomer && stripeCustomerId) {
    // If Supabase has a record but doesn't match Stripe, update Supabase record
    if (existingSupabaseCustomer.stripe_customer_id !== stripeCustomerId) {
      const { error: updateError } = await getSupabaseAdmin()
        .from('customers')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', uuid);

      if (updateError) {
        console.error('[Admin] Customer update failed:', updateError.message);
        throw new Error(
          `Supabase customer record update failed: ${updateError.message}`
        );
      }
    }
    return stripeCustomerId;
  } else {
    // If Supabase has no record, create a new record and return Stripe customer ID
    const upsertedStripeCustomer = await upsertCustomerToSupabase(
      uuid,
      stripeIdToInsert
    );
    if (!upsertedStripeCustomer)
      throw new Error('Supabase customer record creation failed.');

    console.log('[Admin] Customer created for user:', uuid);
    return upsertedStripeCustomer;
  }
};

/**
 * Copies the billing details from the payment method to the customer object.
 */
const copyBillingDetailsToCustomer = async (
  uuid: string,
  payment_method: Stripe.PaymentMethod
) => {
  //Todo: check this assertion
  const customer = payment_method.customer as string;
  const { name, phone, address } = payment_method.billing_details;
  if (!name || !phone || !address) return;
  //@ts-ignore
  await stripe.customers.update(customer, { name, phone, address });
  // Temporairement commenté en raison d'erreurs TypeScript avec types Supabase
  // TODO: Régénérer les types Supabase après stabilisation du schéma
  // const { error: updateError } = await getSupabaseAdmin()
  //   .from('users')
  //   .update({
  //     billing_address: { ...address },
  //     payment_method: { ...payment_method[payment_method.type] }
  //   })
  //   .eq('id', uuid);
  // if (updateError) throw new Error(`Customer update failed: ${updateError.message}`);
};

const manageSubscriptionStatusChange = async (
  subscriptionId: string,
  customerId: string,
  createAction = false
) => {
  // Get customer's UUID from mapping table.
  const { data: customerData, error: noCustomerError } = await getSupabaseAdmin()
    .from('customers')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (noCustomerError)
    throw new Error(`Customer lookup failed: ${noCustomerError.message}`);

  let uuid: string;
  if (customerData) {
    uuid = customerData.id;
  } else {
    // Customer not in our DB yet — look up by Stripe email and create mapping
    console.log(`[Subscription] Customer ${customerId} not in DB — attempting auto-resolve...`);
    const stripeCustomer = await stripe.customers.retrieve(customerId);
    if ('deleted' in stripeCustomer && stripeCustomer.deleted) {
      throw new Error(`Stripe customer ${customerId} was deleted`);
    }
    if (!stripeCustomer.email) {
      throw new Error(`Customer ${customerId} has no email in Stripe — cannot resolve`);
    }
    uuid = await createOrRetrieveCustomer({
      email: stripeCustomer.email,
      uuid: stripeCustomer.metadata?.supabase_uuid || '',
    });
    console.log(`[Subscription] Auto-resolved customer: ${customerId} → ${uuid}`);
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method']
  });
  // Upsert the latest status of the subscription object.
  const subscriptionData: TablesInsert<'subscriptions'> = {
    user_id: uuid,
    stripe_customer_id: subscription.customer as string,
    stripe_subscription_id: subscription.id,
    stripe_price_id: subscription.items.data[0].price.id,
    metadata: subscription.metadata,
    status: subscription.status,
    price_id: subscription.items.data[0].price.id,
    //TODO check quantity on subscription
    // @ts-ignore
    quantity: subscription.quantity,
    cancel_at_period_end: subscription.cancel_at_period_end,
    cancel_at: subscription.cancel_at
      ? toDateTime(subscription.cancel_at).toISOString()
      : null,
    canceled_at: subscription.canceled_at
      ? toDateTime(subscription.canceled_at).toISOString()
      : null,
    current_period_start: toDateTime(
      subscription.current_period_start
    ).toISOString(),
    current_period_end: toDateTime(
      subscription.current_period_end
    ).toISOString(),
    created: toDateTime(subscription.created).toISOString(),
    ended_at: subscription.ended_at
      ? toDateTime(subscription.ended_at).toISOString()
      : null,
    trial_start: subscription.trial_start
      ? toDateTime(subscription.trial_start).toISOString()
      : null,
    trial_end: subscription.trial_end
      ? toDateTime(subscription.trial_end).toISOString()
      : null
  };

  const { error: upsertError } = await getSupabaseAdmin()
    .from('subscriptions')
    .upsert([subscriptionData], {
      onConflict: 'stripe_subscription_id'
    });
  if (upsertError) {
    console.error(`[Admin] Subscription upsert failed (${subscription.id}):`, upsertError.message);
    throw new Error(`Subscription insert/update failed: ${upsertError.message}`);
  }

  // Sync prospection plan based on Stripe subscription status
  try {
    const priceId = subscription.items.data[0]?.price.id;
    if (priceId) {
      const { data: priceData } = await getSupabaseAdmin()
        .from('prices')
        .select('product_id')
        .eq('id', priceId)
        .single();

      if (priceData?.product_id) {
        const { data: productData } = await getSupabaseAdmin()
          .from('products')
          .select('metadata')
          .eq('id', priceData.product_id)
          .single();

        const planKey = (productData?.metadata as Record<string, string>)?.planKey;
        const isActive = ['active', 'trialing'].includes(subscription.status);
        const prospectionPlan = isActive
          ? (planKey === 'ENTERPRISE' ? 'enterprise' : planKey === 'PRO' ? 'pro' : 'freemium')
          : 'freemium';

        const db = getSupabaseAdmin().from('tenants') as any;
        await db
          .update({ prospection_plan: prospectionPlan })
          .eq('user_id', uuid);

        console.log(`[Admin] Synced prospection_plan=${prospectionPlan} for user ${uuid} (stripe status: ${subscription.status}, planKey: ${planKey})`);
      }
    }
  } catch (syncErr: any) {
    console.error(`[Admin] Failed to sync prospection_plan (non-blocking):`, syncErr.message);
  }

  // For a new subscription copy the billing details to the customer object.
  // NOTE: This is a costly operation and should happen at the very end.
  if (createAction && subscription.default_payment_method && uuid)
    //@ts-ignore
    await copyBillingDetailsToCustomer(
      uuid,
      subscription.default_payment_method as Stripe.PaymentMethod
    );
};

export {
  getSupabaseAdmin,
  upsertProductRecord,
  upsertPriceRecord,
  deleteProductRecord,
  deletePriceRecord,
  createOrRetrieveCustomer,
  manageSubscriptionStatusChange
};
