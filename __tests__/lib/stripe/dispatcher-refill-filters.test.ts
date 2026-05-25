/**
 * Tests dispatcher webhook — forward filters_json (v2.1) + backward compat
 * (v2.0).
 *
 * Spec : ticket 2026-05-25-refill-checkout-from-app-hmac-route.md §2
 * Contrat : docs/CONTRAT-BILLING.md §8.4 body purchase v2.1
 *
 * Couvre :
 *  - Webhook avec metadata.filters_json valide → body credit-leads avec
 *    `filters` + contract_version "2.1"
 *  - Webhook sans metadata.filters_json → body credit-leads SANS `filters`
 *    + contract_version "2.0" (backward compat strict)
 *  - Webhook avec filters_json malformé (truncate) → log warning + fallback
 *    "2.0" sans filters (on garde le crédit user)
 *  - Webhook avec filters_json = array (pas object) → log warning + fallback
 *  - Webhook avec filters_json = "null" → fallback v2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

vi.mock('@/utils/stripe/prisma-sync', () => ({
  manageSubscriptionStatusChange: vi.fn(),
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

function makeCheckoutEvent(metadata: Record<string, string>): Stripe.Event {
  return {
    id: 'evt_refill_filters_test',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_filters_test',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_filters_xyz',
        subscription: null,
        customer: 'cus_test',
        metadata,
      },
    },
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatcher — refill v2.1 filters forward', () => {
  it('forwards filters in body + bumps contract_version 2.0→2.1 when metadata.filters_json present', async () => {
    const creditLeadsMock = vi.fn(async () => ({ credited: 500, balance: 500 }));
    const fakeClient = { creditLeads: creditLeadsMock } as any;

    const filters = {
      industry: ['saas'],
      country: 'FR',
      headcount_min: 10,
    };

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeCheckoutEvent({
      kind: 'refill_leads',
      app: 'prospection',
      hub_tenant_id: '33333333-3333-4333-8333-333333333333',
      owner_email: 'buyer@example.com',
      quantity: '500',
      contract_version: '2.1',
      initiated_from: 'app',
      filters_json: JSON.stringify(filters),
    });

    const outcome = await dispatchStripeEvent(event, {
      creditLeadsClient: fakeClient,
    });

    expect(outcome.status).toBe('processed');
    expect(creditLeadsMock).toHaveBeenCalledTimes(1);

    const [, bodyArg] = creditLeadsMock.mock.calls[0];
    expect(bodyArg.source).toBe('purchase');
    expect(bodyArg.contract_version).toBe('2.1');
    expect(bodyArg.filters).toEqual(filters);
  });

  it('emits v2.0 body WITHOUT filters when metadata.filters_json absent (backward compat)', async () => {
    const creditLeadsMock = vi.fn(async () => ({ credited: 100, balance: 100 }));
    const fakeClient = { creditLeads: creditLeadsMock } as any;

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeCheckoutEvent({
      kind: 'refill_leads',
      app: 'prospection',
      hub_tenant_id: '44444444-4444-4444-8444-444444444444',
      owner_email: 'legacy@example.com',
      quantity: '100',
      // pas de filters_json — checkout legacy depuis page Hub
    });

    const outcome = await dispatchStripeEvent(event, {
      creditLeadsClient: fakeClient,
    });

    expect(outcome.status).toBe('processed');
    expect(creditLeadsMock).toHaveBeenCalledTimes(1);

    const [, bodyArg] = creditLeadsMock.mock.calls[0];
    expect(bodyArg.contract_version).toBe('2.0');
    expect(bodyArg.filters).toBeUndefined();
    expect('filters' in bodyArg).toBe(false);
  });

  it('fallback v2.0 (no filters) + log warning if filters_json is malformed JSON (truncated > 500 chars)', async () => {
    const creditLeadsMock = vi.fn(async () => ({ credited: 50, balance: 50 }));
    const fakeClient = { creditLeads: creditLeadsMock } as any;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    // Simule un JSON truncate à 500 chars qui casse la dernière clé
    const event = makeCheckoutEvent({
      kind: 'refill_leads',
      app: 'prospection',
      hub_tenant_id: '55555555-5555-4555-8555-555555555555',
      owner_email: 'oops@example.com',
      quantity: '50',
      filters_json: '{"industry":["saas","fin', // JSON tronqué invalide
    });

    const outcome = await dispatchStripeEvent(event, {
      creditLeadsClient: fakeClient,
    });

    expect(outcome.status).toBe('processed');
    expect(creditLeadsMock).toHaveBeenCalledTimes(1);

    // Pas de filters dans le body — fallback safe
    const [, bodyArg] = creditLeadsMock.mock.calls[0];
    expect(bodyArg.contract_version).toBe('2.0');
    expect(bodyArg.filters).toBeUndefined();

    // Warning log présent
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    const parseWarn = warnCalls.find((m) => m.includes('invalid JSON'));
    expect(parseWarn).toBeDefined();

    warnSpy.mockRestore();
  });

  it('fallback v2.0 if filters_json is an array (not an object)', async () => {
    const creditLeadsMock = vi.fn(async () => ({ credited: 100, balance: 100 }));
    const fakeClient = { creditLeads: creditLeadsMock } as any;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeCheckoutEvent({
      kind: 'refill_leads',
      app: 'prospection',
      hub_tenant_id: '66666666-6666-4666-8666-666666666666',
      owner_email: 'array@example.com',
      quantity: '100',
      filters_json: '["not","an","object"]',
    });

    const outcome = await dispatchStripeEvent(event, {
      creditLeadsClient: fakeClient,
    });

    expect(outcome.status).toBe('processed');
    const [, bodyArg] = creditLeadsMock.mock.calls[0];
    expect(bodyArg.contract_version).toBe('2.0');
    expect(bodyArg.filters).toBeUndefined();

    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('not an object'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('fallback v2.0 if filters_json is the literal string "null"', async () => {
    const creditLeadsMock = vi.fn(async () => ({ credited: 50, balance: 50 }));
    const fakeClient = { creditLeads: creditLeadsMock } as any;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');
    const event = makeCheckoutEvent({
      kind: 'refill_leads',
      app: 'prospection',
      hub_tenant_id: '77777777-7777-4777-8777-777777777777',
      owner_email: 'null@example.com',
      quantity: '50',
      filters_json: 'null',
    });

    const outcome = await dispatchStripeEvent(event, {
      creditLeadsClient: fakeClient,
    });

    expect(outcome.status).toBe('processed');
    const [, bodyArg] = creditLeadsMock.mock.calls[0];
    expect(bodyArg.contract_version).toBe('2.0');
    expect(bodyArg.filters).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('idempotency_key remains DETERMINISTIC (derived from event.id) regardless of v2.0 vs v2.1', async () => {
    const creditLeadsMock = vi.fn(async () => ({ credited: 10, balance: 10 }));
    const fakeClient = { creditLeads: creditLeadsMock } as any;

    const { dispatchStripeEvent } = await import('@/lib/stripe/dispatcher');

    // Run 1 : v2.1 avec filters
    await dispatchStripeEvent(
      makeCheckoutEvent({
        kind: 'refill_leads',
        app: 'prospection',
        hub_tenant_id: '88888888-8888-4888-8888-888888888888',
        owner_email: 'idem@example.com',
        quantity: '10',
        filters_json: '{"a":1}',
      }),
      { creditLeadsClient: fakeClient },
    );
    const key1 = creditLeadsMock.mock.calls[0][1].idempotency_key;

    creditLeadsMock.mockClear();

    // Run 2 : MÊME event.id, MAIS sans filters cette fois (cas de retry où
    // metadata a été stripped). La clé doit rester la même car dérivée du
    // event.id seul → retry safe, pas de double-crédit.
    await dispatchStripeEvent(
      makeCheckoutEvent({
        kind: 'refill_leads',
        app: 'prospection',
        hub_tenant_id: '88888888-8888-4888-8888-888888888888',
        owner_email: 'idem@example.com',
        quantity: '10',
      }),
      { creditLeadsClient: fakeClient },
    );
    const key2 = creditLeadsMock.mock.calls[0][1].idempotency_key;

    expect(key2).toBe(key1);
  });
});
