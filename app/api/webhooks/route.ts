import Stripe from 'stripe';

import { stripe } from '@/utils/stripe/config';
import { getStripeWebhookSecret, getEnvironmentLabel } from '@/utils/env';
import {
  upsertProductRecord,
  upsertPriceRecord,
  manageSubscriptionStatusChange,
  deleteProductRecord,
  deletePriceRecord,
} from '@/utils/stripe/prisma-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const relevantEvents = new Set([
  'product.created',
  'product.updated',
  'product.deleted',
  'price.created',
  'price.updated',
  'price.deleted',
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

export async function POST(req: Request) {
  // CRITIQUE : Stripe envoie du raw bytes signé. NE PAS parser en JSON
  // avant constructEvent — la signature porte sur le body texte exact.
  const body = await req.text();
  const sig = req.headers.get('stripe-signature') as string;

  const webhookSecret = getStripeWebhookSecret();
  const environmentLabel = getEnvironmentLabel();

  let event: Stripe.Event;

  console.log('🔍 [WEBHOOK] Received request');
  console.log('🔍 [WEBHOOK] Environment:', environmentLabel);
  console.log('🔍 [WEBHOOK] Domain:', process.env.DOMAIN || 'localhost');
  console.log('🔍 [WEBHOOK] Signature:', sig ? 'Present' : 'Missing');
  console.log('🔍 [WEBHOOK] Webhook secret:', webhookSecret ? 'Configured' : 'Missing');

  try {
    if (!sig || !webhookSecret) {
      return new Response('Webhook secret not found.', { status: 400 });
    }
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    console.log(`🔔 [WEBHOOK] Event received: ${event.type} (ID: ${event.id})`);
    console.log(
      `🔍 [WEBHOOK] Event data:`,
      JSON.stringify(event.data.object).substring(0, 200) + '...',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.log(`❌ [WEBHOOK] Signature verification failed: ${message}`);
    return new Response(`Webhook Error: ${message}`, { status: 400 });
  }

  if (relevantEvents.has(event.type)) {
    console.log(`✅ [WEBHOOK] Event ${event.type} is relevant, processing...`);
    try {
      switch (event.type) {
        case 'product.created':
        case 'product.updated': {
          const product = event.data.object as Stripe.Product;
          console.log(`📦 [WEBHOOK] Upserting product: ${product.id}`);
          await upsertProductRecord(product);
          console.log(`✅ [WEBHOOK] Product upserted successfully`);
          break;
        }
        case 'price.created':
        case 'price.updated': {
          const price = event.data.object as Stripe.Price;
          console.log(
            `💰 [WEBHOOK] Upserting price: ${price.id} (${price.unit_amount ? price.unit_amount / 100 : '?'}€/${price.recurring?.interval || 'one-time'})`,
          );
          console.log(`💰 [WEBHOOK] Price lookup_key: ${price.lookup_key || 'NONE'}`);
          await upsertPriceRecord(price);
          console.log(`✅ [WEBHOOK] Price upserted successfully`);
          break;
        }
        case 'price.deleted': {
          const price = event.data.object as Stripe.Price;
          console.log(`🗑️  [WEBHOOK] Deleting price: ${price.id}`);
          await deletePriceRecord(price);
          console.log(`✅ [WEBHOOK] Price deleted successfully`);
          break;
        }
        case 'product.deleted': {
          const product = event.data.object as Stripe.Product;
          console.log(`🗑️  [WEBHOOK] Deleting product: ${product.id}`);
          await deleteProductRecord(product);
          console.log(`✅ [WEBHOOK] Product deleted successfully`);
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;
          console.log(
            `📋 [WEBHOOK] Managing subscription: ${subscription.id} (customer: ${subscription.customer})`,
          );
          await manageSubscriptionStatusChange(
            subscription.id,
            subscription.customer as string,
            event.type === 'customer.subscription.created',
          );
          console.log(`✅ [WEBHOOK] Subscription managed successfully`);
          break;
        }
        case 'checkout.session.completed': {
          const checkoutSession = event.data.object as Stripe.Checkout.Session;
          console.log(
            `🛒 [WEBHOOK] Checkout completed: ${checkoutSession.id} (mode: ${checkoutSession.mode})`,
          );
          if (checkoutSession.mode === 'subscription') {
            const subscriptionId = checkoutSession.subscription;
            console.log(
              `📋 [WEBHOOK] Managing subscription from checkout: ${subscriptionId}`,
            );
            await manageSubscriptionStatusChange(
              subscriptionId as string,
              checkoutSession.customer as string,
              true,
            );
            console.log(`✅ [WEBHOOK] Checkout subscription managed successfully`);
          }
          break;
        }
        default:
          throw new Error('Unhandled relevant event!');
      }
      console.log(`✅ [WEBHOOK] Event ${event.type} processed successfully`);
    } catch (error) {
      const stack = error instanceof Error ? error.stack : '';
      console.error(`❌ [WEBHOOK] Error processing ${event.type}:`, error);
      console.error(`❌ [WEBHOOK] Error stack:`, stack);
      return new Response(
        'Webhook handler failed. View your Next.js function logs.',
        {
          status: 400,
        },
      );
    }
  } else {
    console.log(`⏭️  [WEBHOOK] Event ${event.type} not relevant, skipping`);
    return new Response(`Unsupported event type: ${event.type}`, {
      status: 400,
    });
  }
  console.log(`✅ [WEBHOOK] Responding with success for ${event.type}`);
  return new Response(JSON.stringify({ received: true }));
}
