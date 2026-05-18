/**
 * Test smoke pour POST /api/webhooks Stripe (refacto 2026-05-18).
 *
 * Vérifie :
 *   1. 400 si signature manquante / secret manquant
 *   2. 400 si signature invalide
 *   3. 200 + ignored si event hors whitelist (plus de product/price events)
 *   4. 200 si event subscription valide → appelle manageSubscriptionStatusChange
 *   5. 200 si checkout.session.completed avec subscription → appelle handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const constructEventMock = vi.fn();
vi.mock('@/utils/stripe/config', () => ({
  stripe: {
    webhooks: { constructEvent: (...args: any[]) => constructEventMock(...args) },
  },
}));

vi.mock('@/utils/env', () => ({
  getStripeWebhookSecret: () => 'whsec_test_secret',
  getEnvironmentLabel: () => 'test',
}));

const manageSubscriptionMock = vi.fn(async () => undefined);
vi.mock('@/utils/stripe/prisma-sync', () => ({
  manageSubscriptionStatusChange: (...args: any[]) => manageSubscriptionMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq(body: string, sig: string | null) {
  return {
    text: async () => body,
    headers: { get: (k: string) => (k === 'stripe-signature' ? sig : null) },
  } as any;
}

describe('POST /api/webhooks (Stripe)', () => {
  it('returns 400 if signature header is missing', async () => {
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', null));
    expect(res.status).toBe(400);
  });

  it('returns 400 if signature verification fails', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('Invalid signature');
    });
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', 'bad_sig'));
    expect(res.status).toBe(400);
  });

  it('returns 200 + ignored for irrelevant event (e.g. product.created)', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'product.created',
      data: { object: {} },
    });
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', 'good_sig'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ignored).toBe(true);
    expect(manageSubscriptionMock).not.toHaveBeenCalled();
  });

  it('handles customer.subscription.created → calls handler', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_2',
      type: 'customer.subscription.created',
      data: { object: { id: 'sub_1', customer: 'cus_1' } },
    });
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', 'good_sig'));
    expect(res.status).toBe(200);
    expect(manageSubscriptionMock).toHaveBeenCalledWith('sub_1', 'cus_1', true);
  });

  it('handles checkout.session.completed (mode=subscription) → calls handler', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_3',
      type: 'checkout.session.completed',
      data: {
        object: {
          mode: 'subscription',
          subscription: 'sub_2',
          customer: 'cus_2',
        },
      },
    });
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', 'good_sig'));
    expect(res.status).toBe(200);
    expect(manageSubscriptionMock).toHaveBeenCalledWith('sub_2', 'cus_2', true);
  });

  it('returns 400 if handler throws', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_4',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_3', customer: 'cus_3' } },
    });
    manageSubscriptionMock.mockRejectedValueOnce(new Error('DB down'));
    const { POST } = await import('@/app/api/webhooks/route');
    const res = await POST(makeReq('{}', 'good_sig'));
    expect(res.status).toBe(400);
  });
});
