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
 *      (3 essais avec backoff exponentiel), ligne d'alerte `flux=alerte` sur stdout (Grafana, jamais Telegram).
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
import { emettreAlerte, sansAdresse, type AlerteEntree } from '@/lib/notifications/alerte';
import { estCompteDeTest } from '@/lib/email/compte-de-test';
import { estDeTest } from '@/lib/tenants/marque-test';
import type { NotifuseClient } from '@/lib/notifuse/client';

export type StripeDispatchOutcome =
  | { status: 'already_processed'; eventId: string }
  | { status: 'ignored'; eventId: string; reason: string }
  | {
      status: 'processed';
      eventId: string;
      propagation?: PropagationResult;
    }
  | { status: 'failed'; eventId: string; error: string };

export interface DispatcherOptions {
  /**
   * Permet d'injecter un client Notifuse custom dans les tests (mock).
   * En prod, on laisse `manageSubscriptionStatusChange` construire le sien
   * depuis ENV.
   */
  notifuseClient?: NotifuseClient;
  /**
   * Hook d'alerte (mockable). Par défaut → `emettreAlerte` : une ligne JSON `flux=alerte` sur stdout.
   */
  alertFn?: (alerte: AlerteEntree) => unknown;
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
 * en cas d'erreur de propagation, on log + ligne d'alerte, mais on doit
 * retourner 200 à Stripe pour éviter retry inutile (le retry est géré côté
 * Hub via le cron qui re-tente les `processed_at IS NULL`).
 */
export async function dispatchStripeEvent(
  event: Stripe.Event,
  opts: DispatcherOptions = {},
): Promise<StripeDispatchOutcome> {
  const alertFn = opts.alertFn ?? emettreAlerte;

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
        const metaKind = session.metadata?.kind;

        // Flux « refill leads » retiré (Robert 15/11, Prospection ne vend plus de
        // crédits) : un éventuel event résiduel est ignoré, jamais routé.
        if (metaKind === 'refill_leads') {
          console.warn(`[stripe-dispatch] checkout ${session.id} kind=refill_leads ignoré (flux retiré)`);
          return { status: 'ignored', eventId: event.id, reason: 'refill_leads_retired' };
        }

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
        // V1 : ligne d'alerte pour visibilité dunning. V2 = state machine
        // dunning (suspend après N échecs).
        const invoice = event.data.object as Stripe.Invoice;
        const attempt = invoice.attempt_count ?? 0;
        console.warn(
          `[stripe-dispatch] invoice.payment_failed customer=${invoice.customer} ` +
            `attempt=${attempt} amount_due=${invoice.amount_due}`,
        );
        if (attempt >= 3) {
          const cl = await classerEvenement(event, null);
          await alertFn({
            gravite: 'avertissement',
            evenement: 'stripe.dunning',
            message: `Dunning Stripe : ${attempt} paiements échoués, suspension à câbler côté Hub.`,
            impact: cl.impact,
            essai: cl.essai,
            detail: { event_id: event.id, stripe_customer: extractCustomerId(event), tentatives: attempt, montant: invoice.amount_due / 100, devise: invoice.currency?.toUpperCase() },
          });
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
    console.error(`[stripe-dispatch] ${event.type} failed:`, sansAdresse(message));
    const cl = await classerEvenement(event, null);
    try {
      await alertFn({
        gravite: 'critique',
        evenement: 'stripe.dispatcher_ko',
        message: `Webhook Stripe non traité (${event.type}) : ${message.slice(0, 200)}`,
        impact: cl.impact,
        essai: cl.essai,
        detail: { event_id: event.id, event_type: event.type, stripe_customer: extractCustomerId(event) },
      });
    } catch {
      // une alerte ne fait jamais échouer le webhook
    }
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

  // Perf: 1 query updateMany au lieu de N×update (cf. todo/2026-05-21-fix-n1-soft-delete-tenants.md).
  // Critique sur le webhook Stripe (timeout 30s côté Stripe).
  const result = await prisma.tenant.updateMany({
    where: { userId, deletedAt: null },
    data: { deletedAt: new Date(), status: 'deleted' },
  });

  console.log(
    `[stripe-dispatch] customer.deleted ${customerId} → soft-deleted ${result.count} tenant(s)`,
  );
}

/**
 * Si la propagation HMAC vers une app downstream a échoué, ligne d'alerte.
 * Le NotifuseClient retry déjà 3× en interne — donc si on arrive ici, c'est
 * que l'app est vraiment down.
 */
async function maybeAlertPropagationFailures(
  result: PropagationResult,
  event: Stripe.Event,
  alertFn: (alerte: AlerteEntree) => unknown,
): Promise<void> {
  if (!result.failures || result.failures.length === 0) return;

  const cl = await classerEvenement(event, result.tenantId);
  try {
    await alertFn({
      gravite: 'critique',
      evenement: 'stripe.propagation_ko',
      message: `Facturation désynchronisée : propagation Stripe vers ${result.failures.length} app(s) échouée après les retries.`,
      impact: cl.impact,
      essai: cl.essai,
      detail: {
        event_id: event.id,
        event_type: event.type,
        tenant_id: result.tenantId,
        stripe_customer: extractCustomerId(event),
        apps: result.failures.map((f) => f.app).join(','),
        plans: result.failures.map((f) => f.targetPlan).join(','),
        erreur: result.failures[0]?.error?.slice(0, 200),
      },
    });
  } catch {
    // une alerte ne fait jamais échouer le webhook
  }
}

/**
 * Un client réel, ou pas ? Seul un client réel rend une alerte `critique`. Essai = événement Stripe en mode test, organisation marquée de
 * test (`estDeTest`), ou propriétaire dont l'adresse est celle d'un compte d'épreuve (`estCompteDeTest`). Aucune adresse n'en sort.
 * Lecture impossible : on traite comme un vrai client (mieux vaut réveiller pour rien que se taire).
 */
async function classerEvenement(
  event: Stripe.Event,
  tenantId: string | null,
): Promise<{ impact: 'client' | 'interne'; essai: boolean }> {
  if ((event as { livemode?: boolean }).livemode === false) return { impact: 'interne', essai: true };
  try {
    let userId: string | null = null;
    if (tenantId) {
      const t = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { userId: true, metadata: true } });
      if (t && estDeTest(t.metadata)) return { impact: 'interne', essai: true };
      userId = t?.userId ?? null;
    }
    const customerId = extractCustomerId(event);
    const u = userId
      ? await prisma.user.findFirst({ where: { supabaseUserId: userId }, select: { email: true } })
      : customerId
        ? await prisma.user.findFirst({ where: { stripeCustomerId: customerId }, select: { email: true } })
        : null;
    if (u?.email && estCompteDeTest(u.email)) return { impact: 'interne', essai: true };
  } catch {
    // lecture impossible : vrai client par défaut
  }
  return { impact: 'client', essai: false };
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
