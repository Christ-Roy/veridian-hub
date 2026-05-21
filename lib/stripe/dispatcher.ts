/**
 * Dispatcher Stripe — orchestrateur cross-app (ticket 2026-05-21).
 *
 * Le Hub reçoit TOUS les webhooks Stripe (cf docs/CONTRAT-HUB.md §7.4). Ce
 * module est le routage event_type → action(s) cross-app :
 *
 *   1. Persistance idempotente dans `hub_app.stripe_events` (PK = event.id)
 *      → si l'event a déjà été vu et processé, on retourne `already_processed`
 *        sans re-dispatcher. Stripe peut retry jusqu'à 30 min, on doit être safe.
 *   2. Dispatch synchrone (≤30s timeout Stripe) :
 *        - subscription.created/updated  → resync DB + propagation HMAC
 *        - subscription.deleted          → downgrade DB + propagation HMAC free
 *        - invoice.payment_succeeded     → audit only (V1)
 *        - invoice.payment_failed        → marquer dunning (V1 logging only)
 *        - customer.deleted              → soft-delete tenants liés
 *   3. Si propagation HMAC échoue après les retry du NotifuseClient
 *      (3 essais avec backoff exponentiel), alerte Telegram à Robert.
 *
 * Côté tests, on injecte un client Notifuse mocké via `opts.notifuseClient`
 * pour vérifier le comportement sans toucher au réseau.
 */

import Stripe from 'stripe';

import { prisma } from '@/lib/prisma';
import {
  manageSubscriptionStatusChange,
  type PropagationResult,
} from '@/utils/stripe/prisma-sync';
import { sendTelegramAlert } from '@/lib/notifications/telegram';
import type { NotifuseClient } from '@/lib/notifuse/client';

export type StripeDispatchOutcome =
  | { status: 'already_processed'; eventId: string }
  | { status: 'ignored'; eventId: string; reason: string }
  | { status: 'processed'; eventId: string; propagation?: PropagationResult }
  | { status: 'failed'; eventId: string; error: string };

export interface DispatcherOptions {
  /**
   * Permet d'injecter un client Notifuse custom dans les tests (mock).
   * En prod, on laisse `manageSubscriptionStatusChange` construire le sien
   * depuis ENV.
   */
  notifuseClient?: NotifuseClient;
  /**
   * Hook d'alerte Telegram (mockable). Par défaut → `sendTelegramAlert`.
   */
  alertFn?: (message: string) => Promise<boolean>;
}

const RELEVANT_EVENT_TYPES = new Set<string>([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'customer.deleted',
]);

/**
 * Persiste un event Stripe dans la table d'audit. Idempotent : si l'event est
 * déjà présent, on lit son state et on retourne `wasNew=false`.
 */
export async function persistStripeEvent(
  event: Stripe.Event,
): Promise<{ wasNew: boolean; alreadyProcessed: boolean }> {
  const customerId = extractCustomerId(event);

  // INSERT ... ON CONFLICT DO NOTHING via Prisma upsert.
  // On utilise upsert avec un update no-op (`attempts: { increment: 0 }` n'est
  // pas possible — on garde un champ qu'on n'incrémente pas). Pour distinguer
  // "wasNew" vs "déjà vu", on tente d'abord un findUnique.
  const existing = await prisma.stripeEvent.findUnique({
    where: { eventId: event.id },
    select: { eventId: true, processedAt: true },
  });

  if (existing) {
    return { wasNew: false, alreadyProcessed: existing.processedAt !== null };
  }

  await prisma.stripeEvent.create({
    data: {
      eventId: event.id,
      eventType: event.type,
      customerId,
      // event.data est volumineux mais on en a besoin pour replay/debug ;
      // Stripe Event includes data.object (le subscription, invoice, etc.).
      payload: JSON.parse(JSON.stringify(event)) as object,
    },
  });

  return { wasNew: true, alreadyProcessed: false };
}

/**
 * Marque l'event comme processé (succès) ou met à jour l'erreur.
 */
export async function markEventProcessed(
  eventId: string,
  result: { ok: true } | { ok: false; error: string },
): Promise<void> {
  if (result.ok) {
    await prisma.stripeEvent.update({
      where: { eventId },
      data: { processedAt: new Date(), error: null },
    });
  } else {
    await prisma.stripeEvent.update({
      where: { eventId },
      data: {
        error: result.error.slice(0, 2000),
        attempts: { increment: 1 },
      },
    });
  }
}

/**
 * Dispatcher principal — appelé depuis `app/api/webhooks/route.ts` après
 * validation de signature et persistance event.
 *
 * Renvoie un `StripeDispatchOutcome` qui résume l'action prise. Ne throw pas :
 * en cas d'erreur de propagation, on log + alert Telegram, mais on doit
 * retourner 200 à Stripe pour éviter retry inutile (le retry est géré côté
 * Hub via le cron qui re-tente les `processed_at IS NULL`).
 */
export async function dispatchStripeEvent(
  event: Stripe.Event,
  opts: DispatcherOptions = {},
): Promise<StripeDispatchOutcome> {
  const alertFn = opts.alertFn ?? sendTelegramAlert;

  if (!RELEVANT_EVENT_TYPES.has(event.type)) {
    return { status: 'ignored', eventId: event.id, reason: `event_type ${event.type} not relevant` };
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const propagation = await manageSubscriptionStatusChange(
          subscription.id,
          subscription.customer as string,
          event.type === 'customer.subscription.created',
          { notifuseClient: opts.notifuseClient },
        );
        await maybeAlertPropagationFailures(propagation, event, alertFn);
        return { status: 'processed', eventId: event.id, propagation };
      }

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === 'subscription' && session.subscription) {
          const propagation = await manageSubscriptionStatusChange(
            session.subscription as string,
            session.customer as string,
            true,
            { notifuseClient: opts.notifuseClient },
          );
          await maybeAlertPropagationFailures(propagation, event, alertFn);
          return { status: 'processed', eventId: event.id, propagation };
        }
        return { status: 'ignored', eventId: event.id, reason: 'checkout not subscription mode' };
      }

      case 'customer.subscription.trial_will_end': {
        // V1 : log only. V2 enverra un mail "trial finit dans 3j" via Notifuse.
        const sub = event.data.object as Stripe.Subscription;
        console.log(
          `[stripe-dispatch] trial_will_end customer=${sub.customer} trial_end=${sub.trial_end} ` +
            `— mail CTA upgrade à câbler V2`,
        );
        return { status: 'processed', eventId: event.id };
      }

      case 'invoice.payment_succeeded': {
        // V1 : audit only via stripe_events. Dashboard MRR lira la table.
        const invoice = event.data.object as Stripe.Invoice;
        console.log(
          `[stripe-dispatch] invoice.payment_succeeded customer=${invoice.customer} ` +
            `amount=${invoice.amount_paid} currency=${invoice.currency}`,
        );
        return { status: 'processed', eventId: event.id };
      }

      case 'invoice.payment_failed': {
        // V1 : alerte Telegram pour visibilité dunning. V2 = state machine
        // dunning (suspend après N échecs).
        const invoice = event.data.object as Stripe.Invoice;
        const attempt = invoice.attempt_count ?? 0;
        console.warn(
          `[stripe-dispatch] invoice.payment_failed customer=${invoice.customer} ` +
            `attempt=${attempt} amount_due=${invoice.amount_due}`,
        );
        if (attempt >= 3) {
          await alertFn(
            `<b>Stripe dunning</b>\nCustomer ${invoice.customer} a échoué ${attempt} paiements ` +
              `(${invoice.amount_due / 100}${invoice.currency?.toUpperCase()}). ` +
              `Suspend à câbler côté Hub.`,
          );
        }
        return { status: 'processed', eventId: event.id };
      }

      case 'customer.deleted': {
        const customer = event.data.object as Stripe.Customer;
        await softDeleteTenantsForCustomer(customer.id);
        return { status: 'processed', eventId: event.id };
      }

      default:
        return { status: 'ignored', eventId: event.id, reason: 'no handler' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[stripe-dispatch] ${event.type} failed:`, message);
    await alertFn(
      `<b>Stripe webhook dispatcher KO</b>\nevent=${event.type} id=${event.id}\nerr: ${message.slice(0, 500)}`,
    ).catch(() => undefined);
    return { status: 'failed', eventId: event.id, error: message };
  }
}

/**
 * Soft-delete les tenants liés à un Stripe Customer supprimé.
 */
async function softDeleteTenantsForCustomer(customerId: string): Promise<void> {
  const sub = await prisma.subscription.findFirst({
    where: { stripeCustomerId: customerId },
    select: { userId: true },
  });

  let userId: string | null = sub?.userId ?? null;

  if (!userId) {
    const userByCustomer = await prisma.user.findFirst({
      where: { stripeCustomerId: customerId },
      select: { supabaseUserId: true },
    });
    userId = userByCustomer?.supabaseUserId ?? null;
  }

  if (!userId) {
    console.warn(
      `[stripe-dispatch] customer.deleted ${customerId} — no user found, nothing to soft-delete`,
    );
    return;
  }

  const tenants = await prisma.tenant.findMany({
    where: { userId, deletedAt: null },
    select: { id: true },
  });

  for (const t of tenants) {
    await prisma.tenant.update({
      where: { id: t.id },
      data: { deletedAt: new Date(), status: 'deleted' },
    });
  }

  console.log(
    `[stripe-dispatch] customer.deleted ${customerId} → soft-deleted ${tenants.length} tenant(s)`,
  );
}

/**
 * Si la propagation HMAC vers une app downstream a échoué, alerte Telegram.
 * Le NotifuseClient retry déjà 3× en interne — donc si on arrive ici, c'est
 * que l'app est vraiment down.
 */
async function maybeAlertPropagationFailures(
  result: PropagationResult,
  event: Stripe.Event,
  alertFn: (msg: string) => Promise<boolean>,
): Promise<void> {
  if (!result.failures || result.failures.length === 0) return;

  const lines = result.failures
    .map((f) => `  • ${f.app} → ${f.targetPlan}: ${f.error}`)
    .join('\n');

  await alertFn(
    `<b>Stripe propagation KO (3 retries exhausted)</b>\n` +
      `event=${event.type} id=${event.id}\n` +
      `tenant=${result.tenantId ?? '?'} customer=${extractCustomerId(event) ?? '?'}\n` +
      lines,
  ).catch(() => undefined);
}

function extractCustomerId(event: Stripe.Event): string | null {
  const obj = event.data?.object as { customer?: unknown; id?: string } | undefined;
  if (!obj) return null;
  if (typeof obj.customer === 'string') return obj.customer;
  // customer.* events : l'objet EST le customer
  if (event.type.startsWith('customer.') && typeof obj.id === 'string') {
    return obj.id;
  }
  return null;
}
