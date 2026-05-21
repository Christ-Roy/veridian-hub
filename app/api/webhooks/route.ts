// POST /api/webhooks — webhook Stripe central (orchestrateur cross-app).
//
// Refactor 2026-05-21 (ticket stripe-webhook-orchestrator) :
//   - Persistance idempotente dans hub_app.stripe_events (PK = event.id)
//     → un même event reçu 2 fois renvoie 200 sans re-dispatch (Stripe peut
//       retry jusqu'à 30 min jusqu'à ce qu'il reçoive un 200)
//   - Dispatcher unique pour toutes les apps downstream : subscription.*,
//     invoice.*, customer.deleted. Cf docs/CONTRAT-HUB.md §7.4.
//   - Propagation HMAC vers Notifuse via NotifuseClient (3 retry inclus).
//     Si échec → alerte Telegram Robert.
//
// Refactor précédent 2026-05-18 :
//   - Plus de sync products/prices (le catalogue vit dans lib/pricing/plans.ts).
//   - Stripe reste source de vérité pour l'ÉTAT des subscriptions.

import Stripe from 'stripe';

import { stripe } from '@/utils/stripe/config';
import { getStripeWebhookSecret, getEnvironmentLabel } from '@/utils/env';
import {
  dispatchStripeEvent,
  persistStripeEvent,
  markEventProcessed,
} from '@/lib/stripe/dispatcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // CRITIQUE : Stripe envoie du raw bytes signé. NE PAS parser en JSON
  // avant constructEvent — la signature porte sur le body texte exact.
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

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

  // ─── Idempotence : persist d'abord, dispatch ensuite ───
  // Si l'event est déjà processé (Stripe retry sur un 200 perdu en route),
  // on renvoie 200 sans re-dispatcher (sinon double-update tenant).
  let persistedNow = false;
  try {
    const { wasNew, alreadyProcessed } = await persistStripeEvent(event);
    persistedNow = wasNew;

    if (!wasNew && alreadyProcessed) {
      console.log(`[webhook] ${event.id} already processed, returning 200 idempotent`);
      return new Response(
        JSON.stringify({ received: true, idempotent: true }),
        { status: 200 },
      );
    }
    // wasNew=false && alreadyProcessed=false : event vu mais jamais terminé
    // (crash dispatcher précédent). On retente le dispatch → c'est ce qu'on
    // veut faire.
  } catch (persistErr) {
    // Persist DB en panne → on continue quand même : mieux vaut dispatcher
    // sans audit que perdre l'event. Le retry Stripe nous donnera une 2ᵉ chance.
    console.error(
      `[webhook] persist failed (continuing without idempotence guard):`,
      persistErr instanceof Error ? persistErr.message : persistErr,
    );
  }

  // ─── Dispatch ───
  const outcome = await dispatchStripeEvent(event);

  // ─── Mark event status ───
  try {
    if (outcome.status === 'processed' || outcome.status === 'ignored') {
      await markEventProcessed(event.id, { ok: true });
    } else if (outcome.status === 'failed') {
      await markEventProcessed(event.id, { ok: false, error: outcome.error });
    }
  } catch (markErr) {
    console.error(
      `[webhook] mark event status failed (non-blocking):`,
      markErr instanceof Error ? markErr.message : markErr,
    );
  }

  // ─── Réponse à Stripe ───
  // On retourne 200 dans tous les cas hors signature invalide, pour éviter
  // les retry Stripe inutiles. Les échecs de dispatch (failures partielles
  // de propagation) sont déjà alertés Telegram par le dispatcher et tracés
  // dans stripe_events.error. Le cron retry (à câbler P2) consommera la
  // liste des stripe_events WHERE processed_at IS NULL.
  console.log(
    `[webhook] ${event.type} (id=${event.id}) outcome=${outcome.status} persistedNow=${persistedNow}`,
  );

  return new Response(
    JSON.stringify({
      received: true,
      outcome: outcome.status,
      eventId: event.id,
    }),
    { status: 200 },
  );
}
