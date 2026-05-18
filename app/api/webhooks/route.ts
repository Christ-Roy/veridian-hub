// POST /api/webhooks — webhook Stripe.
//
// Refactor 2026-05-18 :
// - Plus de sync products/prices (le catalogue vit dans lib/pricing/plans.ts).
// - Seuls les events subscription + checkout sont traités.
// - Stripe reste source de vérité pour l'ÉTAT des subscriptions.

import Stripe from 'stripe';

import { stripe } from '@/utils/stripe/config';
import { getStripeWebhookSecret, getEnvironmentLabel } from '@/utils/env';
import { manageSubscriptionStatusChange } from '@/utils/stripe/prisma-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const relevantEvents = new Set([
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

  try {
    if (!sig || !webhookSecret) {
      return new Response('Webhook secret not found.', { status: 400 });
    }
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    console.log(
      `[webhook] ${event.type} (id=${event.id}) env=${environmentLabel}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.log(`[webhook] signature verification failed: ${message}`);
    return new Response(`Webhook Error: ${message}`, { status: 400 });
  }

  if (!relevantEvents.has(event.type)) {
    console.log(`[webhook] ${event.type} not relevant, skipping`);
    return new Response(JSON.stringify({ received: true, ignored: true }), { status: 200 });
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await manageSubscriptionStatusChange(
          subscription.id,
          subscription.customer as string,
          event.type === 'customer.subscription.created',
        );
        break;
      }
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === 'subscription' && session.subscription) {
          await manageSubscriptionStatusChange(
            session.subscription as string,
            session.customer as string,
            true,
          );
        }
        break;
      }
    }
    console.log(`[webhook] ${event.type} processed OK`);
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (error) {
    console.error(`[webhook] Error processing ${event.type}:`, error);
    return new Response('Webhook handler failed. Check Hub logs.', { status: 400 });
  }
}
