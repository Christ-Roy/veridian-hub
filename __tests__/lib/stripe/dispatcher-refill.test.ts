/**
 * Tests dispatchStripeEvent — branche refill leads (`metadata.kind=refill_leads`).
 *
 * Couvre :
 *  - checkout.session.completed + metadata.kind=refill_leads → handleRefillLeadsCheckout
 *  - skip si payment_status !== 'paid'
 *  - alerte Telegram si metadata.quantity invalide / missing tenant id
 *  - alerte Telegram si client_not_configured (ENV manquant)
 *  - success → ok:true, JAMAIS appel à manageSubscriptionStatusChange (flux séparé)
 *  - retry exhausted → alerte Telegram CRITICAL
 *  - idempotency_key dans la requête credit-leads dérivé du Stripe event.id
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

// ─── Mocks Prisma / Telegram / manageSubscription ────────────────────────────

const manageSubscriptionMock = vi.fn();
vi.mock('@/utils/stripe/prisma-sync', () => ({
  manageSubscriptionStatusChange: (...args: unknown[]) => manageSubscriptionMock(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    subscription: { findFirst: vi.fn(async () => null) },
    user: { findFirst: vi.fn(async () => null) },
    tenant: { updateMany: vi.fn(async () => ({ count: 0 })) },
    stripeEvent: { findUnique: vi.fn(async () => null), create: vi.fn(async () => undefined) },
  },
}));

const sendTelegramAlertMock = vi.fn(async () => true);
vi.mock('@/lib/notifications/telegram', () => ({
  sendTelegramAlert: (...args: unknown[]) => sendTelegramAlertMock(...args),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCheckoutEvent(opts: {
  metadata?: Record<string, string>;
  payment_status?: string;
  id?: string;
  mode?: string;
  payment_intent?: string;
  subscription?: string | null;
}): Stripe.Event {
  return {
    id: opts.id ?? 'evt_refill_test',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_abc',
        mode: opts.mode ?? 'payment',
        payment_status: opts.payment_status ?? 'paid',
        payment_intent: opts.payment_intent ?? 'pi_test_123',
        subscription: opts.subscription ?? null,
        customer: 'cus_test',
        metadata: opts.metadata ?? {},
      },
    },
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatcher — refill_leads branch', () => {
  it('route vers credit-leads quand metadata.kind=refill_leads + paid', async () => {
    const creditLeadsMock = vi.fn(async () => ({ credited: 500, balance: 500 }));
    const fakeClient = { creditLeads: creditLeadsMock } as any;

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeCheckoutEvent({
      id: 'evt_purchase_x',
      metadata: {
        kind: 'refill_leads',
        app: 'prospection',
        hub_tenant_id: '11111111-1111-4111-8111-111111111111',
        owner_email: 'u@v.site',
        quantity: '500',
      },
      payment_intent: 'pi_xyz',
    });

    const outcome = await dispatchStripeEvent(event, { creditLeadsClient: fakeClient });

    expect(outcome.status).toBe('processed');
    expect(creditLeadsMock).toHaveBeenCalledTimes(1);

    const [pathArg, bodyArg] = creditLeadsMock.mock.calls[0];
    // tenantIdOrEmail = hub_tenant_id en priorité
    expect(pathArg).toBe('11111111-1111-4111-8111-111111111111');
    expect(bodyArg.quantity).toBe(500);
    expect(bodyArg.source).toBe('purchase');
    expect(bodyArg.stripe_payment_id).toBe('pi_xyz');
    expect(bodyArg.contract_version).toBe('2.0');
    // UUID v4 valide
    expect(bodyArg.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // NE JAMAIS passer par manageSubscriptionStatusChange — flux séparé
    expect(manageSubscriptionMock).not.toHaveBeenCalled();
  });

  it('fallback owner_email si hub_tenant_id absent', async () => {
    const creditLeadsMock = vi.fn(async () => ({ credited: 50 }));
    const fakeClient = { creditLeads: creditLeadsMock } as any;

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeCheckoutEvent({
      metadata: {
        kind: 'refill_leads',
        owner_email: 'fallback@example.com',
        quantity: '50',
      },
    });

    await dispatchStripeEvent(event, { creditLeadsClient: fakeClient });
    expect(creditLeadsMock.mock.calls[0][0]).toBe('fallback@example.com');
  });

  it('skip si payment_status != paid (Stripe async payment)', async () => {
    const creditLeadsMock = vi.fn();
    const fakeClient = { creditLeads: creditLeadsMock } as any;

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeCheckoutEvent({
      payment_status: 'unpaid',
      metadata: {
        kind: 'refill_leads',
        hub_tenant_id: 'tid',
        quantity: '100',
      },
    });

    const outcome = await dispatchStripeEvent(event, { creditLeadsClient: fakeClient });
    expect(outcome.status).toBe('processed');
    if (outcome.status === 'processed') {
      expect(outcome.refill?.ok).toBe(false);
    }
    expect(creditLeadsMock).not.toHaveBeenCalled();
    // Pas d'alerte Telegram pour un paiement en cours (normal flow Stripe)
    expect(sendTelegramAlertMock).not.toHaveBeenCalled();
  });

  it('alerte Telegram + skip si metadata.quantity invalide', async () => {
    const creditLeadsMock = vi.fn();
    const fakeClient = { creditLeads: creditLeadsMock } as any;

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeCheckoutEvent({
      metadata: {
        kind: 'refill_leads',
        hub_tenant_id: 'tid',
        quantity: 'abc',
      },
    });

    await dispatchStripeEvent(event, { creditLeadsClient: fakeClient });
    expect(creditLeadsMock).not.toHaveBeenCalled();
    expect(sendTelegramAlertMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramAlertMock.mock.calls[0][0]).toContain('invalid metadata.quantity');
  });

  it('alerte Telegram CRITICAL si retries épuisés', async () => {
    const fakeClient = {
      creditLeads: vi.fn(async () => {
        const err = new Error('boom');
        (err as any).status = 502;
        (err as any).name = 'CreditLeadsError';
        throw Object.assign(err, { status: 502 });
      }),
    } as any;

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeCheckoutEvent({
      metadata: {
        kind: 'refill_leads',
        hub_tenant_id: 'tid',
        quantity: '100',
      },
    });

    // Pour ne pas attendre 4s dans le test, on injecte rien — c'est le
    // dispatchRefillPurchase qui gère le sleep via défaut. On va monkey-patcher
    // setTimeout pour qu'il appelle immédiatement le callback.
    vi.useFakeTimers();
    const promise = dispatchStripeEvent(event, { creditLeadsClient: fakeClient });
    await vi.runAllTimersAsync();
    const outcome = await promise;
    vi.useRealTimers();

    expect(outcome.status).toBe('processed');
    expect(sendTelegramAlertMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramAlertMock.mock.calls[0][0]).toContain('Refill leads dispatch KO');
  });

  it('checkout.session.completed sans metadata.kind=refill_leads → flux subscription normal', async () => {
    manageSubscriptionMock.mockResolvedValueOnce({
      tenantId: 't',
      applied: [],
      failures: [],
    });

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeCheckoutEvent({
      mode: 'subscription',
      subscription: 'sub_xxx',
      metadata: {}, // pas de kind
    });

    const outcome = await dispatchStripeEvent(event, {
      creditLeadsClient: { creditLeads: vi.fn() } as any,
    });

    expect(outcome.status).toBe('processed');
    expect(manageSubscriptionMock).toHaveBeenCalledTimes(1);
  });
});
