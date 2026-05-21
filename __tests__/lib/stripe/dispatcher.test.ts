/**
 * Tests dispatchStripeEvent (lib/stripe/dispatcher.ts).
 *
 * Couvre :
 *  - event type hors RELEVANT_EVENT_TYPES → ignored
 *  - subscription.created/updated/deleted → manageSubscriptionStatusChange(...)
 *  - checkout.session.completed mode=subscription → manageSubscriptionStatusChange(...)
 *  - checkout.session.completed mode=payment → ignored
 *  - trial_will_end / invoice.payment_succeeded → processed (log only V1)
 *  - invoice.payment_failed (attempt≥3) → alertFn appelée
 *  - customer.deleted → processed via soft-delete tenants
 *  - propagation.failures non-vide → alertFn appelée avec event.id
 *  - manageSubscriptionStatusChange throw → status=failed + alertFn appelée
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

// ─── Mocks ────────────────────────────────────────────────────────────────

const manageSubscriptionMock = vi.fn();
vi.mock('@/utils/stripe/prisma-sync', () => ({
  manageSubscriptionStatusChange: (...args: unknown[]) => manageSubscriptionMock(...args),
}));

const subscriptionFindFirstMock = vi.fn();
const userFindFirstMock = vi.fn();
const tenantFindManyMock = vi.fn();
const tenantUpdateMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    subscription: { findFirst: (...a: unknown[]) => subscriptionFindFirstMock(...a) },
    user: { findFirst: (...a: unknown[]) => userFindFirstMock(...a) },
    tenant: {
      findMany: (...a: unknown[]) => tenantFindManyMock(...a),
      update: (...a: unknown[]) => tenantUpdateMock(...a),
    },
  },
}));

const sendTelegramAlertMock = vi.fn(async () => true);
vi.mock('@/lib/notifications/telegram', () => ({
  sendTelegramAlert: (...args: unknown[]) => sendTelegramAlertMock(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeEvent<T extends Stripe.Event['type']>(
  type: T,
  data: object,
  id = 'evt_test_123',
): Stripe.Event {
  return {
    id,
    type,
    data: { object: data },
  } as unknown as Stripe.Event;
}

function emptyPropagation(overrides: Partial<{ tenantId: string | null; applied: unknown[]; failures: unknown[] }> = {}) {
  return {
    tenantId: null,
    applied: [],
    failures: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  manageSubscriptionMock.mockResolvedValue(emptyPropagation());
  subscriptionFindFirstMock.mockResolvedValue(null);
  userFindFirstMock.mockResolvedValue(null);
  tenantFindManyMock.mockResolvedValue([]);
  tenantUpdateMock.mockResolvedValue(undefined);
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('dispatchStripeEvent — RELEVANT_EVENT_TYPES filtering', () => {
  it('ignores events not in whitelist (product.created)', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('product.created' as Stripe.Event['type'], {});

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('ignored');
    expect(result.eventId).toBe('evt_test_123');
    if (result.status === 'ignored') {
      expect(result.reason).toMatch(/not relevant/);
    }
    expect(manageSubscriptionMock).not.toHaveBeenCalled();
    expect(sendTelegramAlertMock).not.toHaveBeenCalled();
  });
});

describe('dispatchStripeEvent — subscription lifecycle', () => {
  it('customer.subscription.created → manageSubscriptionStatusChange(sub, customer, createdNow=true, opts)', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const notifuseClient = { fake: 'client' } as unknown as Parameters<typeof dispatchStripeEvent>[1] extends infer O
      ? O extends { notifuseClient?: infer NC }
        ? NC
        : never
      : never;

    const event = makeEvent('customer.subscription.created', {
      id: 'sub_abc',
      customer: 'cus_abc',
    });

    const result = await dispatchStripeEvent(event, { notifuseClient: notifuseClient as never });

    expect(result.status).toBe('processed');
    if (result.status === 'processed') {
      expect(result.eventId).toBe('evt_test_123');
    }
    expect(manageSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(manageSubscriptionMock).toHaveBeenCalledWith(
      'sub_abc',
      'cus_abc',
      true,
      { notifuseClient },
    );
  });

  it('customer.subscription.updated → createdNow=false', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('customer.subscription.updated', {
      id: 'sub_upd',
      customer: 'cus_upd',
    });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('processed');
    expect(manageSubscriptionMock).toHaveBeenCalledWith(
      'sub_upd',
      'cus_upd',
      false,
      { notifuseClient: undefined },
    );
  });

  it('customer.subscription.deleted → createdNow=false (downgrade)', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('customer.subscription.deleted', {
      id: 'sub_del',
      customer: 'cus_del',
    });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('processed');
    expect(manageSubscriptionMock).toHaveBeenCalledWith(
      'sub_del',
      'cus_del',
      false,
      { notifuseClient: undefined },
    );
  });

  it('returns propagation result inside processed outcome', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const fakeProp = emptyPropagation({
      tenantId: 'tenant_42',
      applied: [{ app: 'notifuse', targetPlan: 'pro', immune: false }],
    });
    manageSubscriptionMock.mockResolvedValueOnce(fakeProp);

    const event = makeEvent('customer.subscription.created', {
      id: 'sub_1',
      customer: 'cus_1',
    });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('processed');
    if (result.status === 'processed') {
      expect(result.propagation).toEqual(fakeProp);
    }
  });
});

describe('dispatchStripeEvent — checkout.session.completed', () => {
  it('mode=subscription + subscription present → calls manageSubscriptionStatusChange with createdNow=true', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('checkout.session.completed', {
      id: 'cs_test',
      mode: 'subscription',
      subscription: 'sub_from_checkout',
      customer: 'cus_from_checkout',
    });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('processed');
    expect(manageSubscriptionMock).toHaveBeenCalledWith(
      'sub_from_checkout',
      'cus_from_checkout',
      true,
      { notifuseClient: undefined },
    );
  });

  it('mode=payment → ignored (no subscription dispatched)', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('checkout.session.completed', {
      id: 'cs_pay',
      mode: 'payment',
      subscription: null,
      customer: 'cus_x',
    });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('ignored');
    if (result.status === 'ignored') {
      expect(result.reason).toMatch(/checkout not subscription mode/);
    }
    expect(manageSubscriptionMock).not.toHaveBeenCalled();
  });

  it('mode=subscription but subscription missing → ignored', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('checkout.session.completed', {
      id: 'cs_missing',
      mode: 'subscription',
      subscription: null,
      customer: 'cus_x',
    });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('ignored');
    expect(manageSubscriptionMock).not.toHaveBeenCalled();
  });
});

describe('dispatchStripeEvent — V1 log-only events', () => {
  it('customer.subscription.trial_will_end → processed (no manageSubscription call)', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('customer.subscription.trial_will_end', {
      id: 'sub_trial',
      customer: 'cus_trial',
      trial_end: 1234567890,
    });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('processed');
    expect(manageSubscriptionMock).not.toHaveBeenCalled();
    expect(sendTelegramAlertMock).not.toHaveBeenCalled();
  });

  it('invoice.payment_succeeded → processed (audit only)', async () => {
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('invoice.payment_succeeded', {
      id: 'in_paid',
      customer: 'cus_paid',
      amount_paid: 2900,
      currency: 'eur',
    });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('processed');
    expect(manageSubscriptionMock).not.toHaveBeenCalled();
    expect(sendTelegramAlertMock).not.toHaveBeenCalled();
  });

  it('invoice.payment_failed with attempt<3 → processed without alert', async () => {
    const alertFn = vi.fn(async () => true);
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('invoice.payment_failed', {
      id: 'in_fail',
      customer: 'cus_fail',
      attempt_count: 1,
      amount_due: 2900,
      currency: 'eur',
    });

    const result = await dispatchStripeEvent(event, { alertFn });

    expect(result.status).toBe('processed');
    expect(alertFn).not.toHaveBeenCalled();
  });

  it('invoice.payment_failed with attempt>=3 → alertFn appelée (dunning Telegram)', async () => {
    const alertFn = vi.fn(async () => true);
    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('invoice.payment_failed', {
      id: 'in_dunning',
      customer: 'cus_dunning',
      attempt_count: 3,
      amount_due: 2900,
      currency: 'eur',
    });

    const result = await dispatchStripeEvent(event, { alertFn });

    expect(result.status).toBe('processed');
    expect(alertFn).toHaveBeenCalledTimes(1);
    const message = alertFn.mock.calls[0][0];
    expect(message).toMatch(/Stripe dunning/);
    expect(message).toMatch(/cus_dunning/);
    expect(message).toMatch(/3 paiements/);
  });
});

describe('dispatchStripeEvent — customer.deleted', () => {
  it('soft-deletes tenants for the customer via subscription lookup', async () => {
    subscriptionFindFirstMock.mockResolvedValueOnce({ userId: 'user_uuid_1' });
    tenantFindManyMock.mockResolvedValueOnce([{ id: 'tenant_a' }, { id: 'tenant_b' }]);

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('customer.deleted', { id: 'cus_gone' });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('processed');
    expect(subscriptionFindFirstMock).toHaveBeenCalledWith({
      where: { stripeCustomerId: 'cus_gone' },
      select: { userId: true },
    });
    expect(tenantFindManyMock).toHaveBeenCalledWith({
      where: { userId: 'user_uuid_1', deletedAt: null },
      select: { id: true },
    });
    expect(tenantUpdateMock).toHaveBeenCalledTimes(2);
    expect(tenantUpdateMock).toHaveBeenNthCalledWith(1, {
      where: { id: 'tenant_a' },
      data: expect.objectContaining({ status: 'deleted', deletedAt: expect.any(Date) }),
    });
    expect(tenantUpdateMock).toHaveBeenNthCalledWith(2, {
      where: { id: 'tenant_b' },
      data: expect.objectContaining({ status: 'deleted', deletedAt: expect.any(Date) }),
    });
  });

  it('falls back to user.findFirst when no subscription found', async () => {
    subscriptionFindFirstMock.mockResolvedValueOnce(null);
    userFindFirstMock.mockResolvedValueOnce({ supabaseUserId: 'user_uuid_2' });
    tenantFindManyMock.mockResolvedValueOnce([{ id: 'tenant_c' }]);

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('customer.deleted', { id: 'cus_no_sub' });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('processed');
    expect(userFindFirstMock).toHaveBeenCalledWith({
      where: { stripeCustomerId: 'cus_no_sub' },
      select: { supabaseUserId: true },
    });
    expect(tenantUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('processes cleanly when no user found (no tenant update)', async () => {
    subscriptionFindFirstMock.mockResolvedValueOnce(null);
    userFindFirstMock.mockResolvedValueOnce(null);

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('customer.deleted', { id: 'cus_orphan' });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('processed');
    expect(tenantFindManyMock).not.toHaveBeenCalled();
    expect(tenantUpdateMock).not.toHaveBeenCalled();
  });
});

describe('dispatchStripeEvent — failure handling', () => {
  it('manageSubscriptionStatusChange throws → status=failed + alertFn appelée avec event.id', async () => {
    manageSubscriptionMock.mockRejectedValueOnce(new Error('Stripe API down'));
    const alertFn = vi.fn(async () => true);

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent(
      'customer.subscription.created',
      { id: 'sub_x', customer: 'cus_x' },
      'evt_failed_42',
    );

    const result = await dispatchStripeEvent(event, { alertFn });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.eventId).toBe('evt_failed_42');
      expect(result.error).toMatch(/Stripe API down/);
    }
    expect(alertFn).toHaveBeenCalledTimes(1);
    const message = alertFn.mock.calls[0][0];
    expect(message).toMatch(/dispatcher KO/);
    expect(message).toMatch(/evt_failed_42/);
    expect(message).toMatch(/Stripe API down/);
  });

  it('non-Error throw → status=failed with stringified message', async () => {
    manageSubscriptionMock.mockRejectedValueOnce('string error');
    const alertFn = vi.fn(async () => true);

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('customer.subscription.created', {
      id: 'sub_y',
      customer: 'cus_y',
    });

    const result = await dispatchStripeEvent(event, { alertFn });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe('string error');
    }
  });

  it('propagation.failures non-vide → alertFn appelée avec event.id et lignes failures', async () => {
    manageSubscriptionMock.mockResolvedValueOnce({
      tenantId: 'tenant_99',
      applied: [],
      failures: [
        { app: 'notifuse', targetPlan: 'pro', error: 'HTTP 503 timeout' },
      ],
    });
    const alertFn = vi.fn(async () => true);

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent(
      'customer.subscription.updated',
      { id: 'sub_prop', customer: 'cus_prop' },
      'evt_prop_77',
    );

    const result = await dispatchStripeEvent(event, { alertFn });

    expect(result.status).toBe('processed');
    expect(alertFn).toHaveBeenCalledTimes(1);
    const message = alertFn.mock.calls[0][0];
    expect(message).toMatch(/Stripe propagation KO/);
    expect(message).toMatch(/evt_prop_77/);
    expect(message).toMatch(/tenant_99/);
    expect(message).toMatch(/notifuse/);
    expect(message).toMatch(/HTTP 503 timeout/);
  });

  it('propagation.failures vide → alertFn PAS appelée', async () => {
    manageSubscriptionMock.mockResolvedValueOnce({
      tenantId: 'tenant_ok',
      applied: [{ app: 'notifuse', targetPlan: 'pro', immune: false }],
      failures: [],
    });
    const alertFn = vi.fn(async () => true);

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('customer.subscription.updated', {
      id: 'sub_clean',
      customer: 'cus_clean',
    });

    const result = await dispatchStripeEvent(event, { alertFn });

    expect(result.status).toBe('processed');
    expect(alertFn).not.toHaveBeenCalled();
  });
});

describe('dispatchStripeEvent — alertFn default fallback', () => {
  it('uses sendTelegramAlert when opts.alertFn not provided (on failure)', async () => {
    manageSubscriptionMock.mockRejectedValueOnce(new Error('boom'));

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeEvent('customer.subscription.created', {
      id: 'sub_z',
      customer: 'cus_z',
    });

    const result = await dispatchStripeEvent(event);

    expect(result.status).toBe('failed');
    expect(sendTelegramAlertMock).toHaveBeenCalledTimes(1);
  });
});
