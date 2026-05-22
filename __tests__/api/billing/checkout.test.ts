/**
 * Test POST /api/billing/checkout — création session Stripe via catalogue
 * lib/pricing/plans.ts (Robert 2026-05-18).
 *
 * Vérifie :
 *   1. 401 si pas de session
 *   2. 400 si JSON invalide / payload schema invalide
 *   3. 400 si plan inconnu (pas dans le catalogue)
 *   4. 400 si plan free (pas de checkout, doit passer par /api/tenants/start)
 *   5. 400 si plan non-Stripe (lifetime_*, internal)
 *   6. 503 si Stripe Price ID pas configuré (placeholder TODO)
 *   7. 502 si Stripe API call fail
 *   8. 200 + URL si tout OK, metadata `plan_key` + `user_uuid` + `app` set
 *   9. automatic_tax activé sur toute session (Stripe Tax — Robert 2026-05-22)
 *  10. metadata.app = 'bundle' pour un plan multi-apps
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionsCreateMock = vi.fn();
vi.mock('@/utils/stripe/config', () => ({
  stripe: {
    checkout: {
      sessions: { create: (...args: any[]) => sessionsCreateMock(...args) },
    },
  },
}));

vi.mock('@/utils/stripe/server', () => ({
  resolveStripeCustomerId: vi.fn(async () => 'cus_test_123'),
}));

let mockUser: any = {
  id: 'u1',
  email: 'test@veridian.site',
  supabaseUserId: 'uuid-1',
};

vi.mock('@/lib/auth/get-user', () => ({
  requireUser: vi.fn(async () => {
    if (!mockUser) {
      throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return mockUser;
  }),
  userUuid: (u: any) => u.supabaseUserId,
}));

// Mock du catalogue : on remplace les helpers pour contrôler les cas test
vi.mock('@/lib/pricing/helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pricing/helpers')>('@/lib/pricing/helpers');
  return {
    ...actual,
    tryGetPlanByKey: vi.fn((k: string) => {
      const fixtures: Record<string, any> = {
        'notifuse-pro': {
          key: 'notifuse-pro',
          price_eur: 19,
          plan_source: 'stripe',
          apps: ['notifuse'],
          stripePriceId: { month: 'price_test_notifuse_pro_m', year: null },
        },
        'notifuse-pro-no-stripe': {
          key: 'notifuse-pro-no-stripe',
          price_eur: 19,
          plan_source: 'stripe',
          apps: ['notifuse'],
          stripePriceId: { month: null, year: null }, // placeholder
        },
        'notifuse-free': { key: 'notifuse-free', price_eur: 0, plan_source: 'stripe', apps: ['notifuse'], stripePriceId: { month: null, year: null } },
        'lifetime-partner': {
          key: 'lifetime-partner',
          price_eur: 0,
          plan_source: 'lifetime_partner',
          apps: ['notifuse', 'prospection'],
          stripePriceId: { month: null, year: null },
        },
        // Bundle multi-apps — vérifie metadata.app = 'bundle'.
        'veridian-pro': {
          key: 'veridian-pro',
          price_eur: 49,
          plan_source: 'stripe',
          apps: ['notifuse', 'prospection'],
          stripePriceId: { month: 'price_test_veridian_pro_m', year: null },
        },
      };
      return fixtures[k] ?? null;
    }),
    getStripePriceIdForCheckout: vi.fn((k: string, interval: string) => {
      if (k === 'notifuse-pro' && interval === 'month') return 'price_test_notifuse_pro_m';
      if (k === 'veridian-pro' && interval === 'month') return 'price_test_veridian_pro_m';
      throw new Error(`No Stripe Price ID for ${k}/${interval}`);
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { id: 'u1', email: 'test@veridian.site', supabaseUserId: 'uuid-1' };
  sessionsCreateMock.mockReset();
});

function makeReq(body: any) {
  return { json: async () => body } as any;
}

describe('POST /api/billing/checkout', () => {
  it('returns 401 if not authenticated', async () => {
    mockUser = null;
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(makeReq({ plan: 'notifuse-pro' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid JSON', async () => {
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST({ json: async () => { throw new Error('bad'); } } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 on missing plan field', async () => {
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 on unknown plan', async () => {
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(makeReq({ plan: 'unicorn' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unknown_plan');
  });

  it('returns 400 if plan is free (no checkout needed)', async () => {
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(makeReq({ plan: 'notifuse-free' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('plan_is_free');
  });

  it('returns 400 if plan is lifetime (not payable via Stripe)', async () => {
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(makeReq({ plan: 'lifetime-partner' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('plan_not_payable');
  });

  it('returns 503 if Stripe Price ID is placeholder (TODO)', async () => {
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(makeReq({ plan: 'notifuse-pro-no-stripe' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('stripe_price_not_configured');
  });

  it('returns 502 if Stripe checkout creation fails', async () => {
    sessionsCreateMock.mockRejectedValueOnce(new Error('Stripe down'));
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(makeReq({ plan: 'notifuse-pro', interval: 'month' }));
    expect(res.status).toBe(502);
  });

  it('returns 200 + URL when all valid, metadata includes plan_key + user_uuid + app', async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/test_123',
    });
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(makeReq({ plan: 'notifuse-pro', interval: 'month' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain('checkout.stripe.com');

    // Vérif metadata propagée vers Stripe pour le webhook
    const sessionArgs = sessionsCreateMock.mock.calls[0][0];
    expect(sessionArgs.subscription_data.metadata.plan_key).toBe('notifuse-pro');
    expect(sessionArgs.subscription_data.metadata.user_uuid).toBe('uuid-1');
    expect(sessionArgs.subscription_data.metadata.app).toBe('notifuse');
    expect(sessionArgs.line_items[0].price).toBe('price_test_notifuse_pro_m');
    expect(sessionArgs.mode).toBe('subscription');
  });

  it('enables automatic_tax on the checkout session (Stripe Tax — Robert 2026-05-22)', async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      id: 'cs_tax',
      url: 'https://checkout.stripe.com/c/tax',
    });
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(makeReq({ plan: 'notifuse-pro', interval: 'month' }));
    expect(res.status).toBe(200);

    const sessionArgs = sessionsCreateMock.mock.calls[0][0];
    // Stripe Tax : la TVA doit être collectée auto sur TOUTE session.
    expect(sessionArgs.automatic_tax).toEqual({ enabled: true });
    // customer_update.name='auto' est requis par Stripe Tax.
    expect(sessionArgs.customer_update).toMatchObject({ name: 'auto', address: 'auto' });
  });

  it('sets metadata.app = "bundle" for a multi-app plan', async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      id: 'cs_bundle',
      url: 'https://checkout.stripe.com/c/bundle',
    });
    const { POST } = await import('@/app/api/billing/checkout/route');
    const res = await POST(makeReq({ plan: 'veridian-pro', interval: 'month' }));
    expect(res.status).toBe(200);

    const sessionArgs = sessionsCreateMock.mock.calls[0][0];
    // Un bundle débloque 2 apps → le dispatcher webhook doit savoir router
    // vers Notifuse ET Prospection (cf CONTRAT-BILLING.md §8.2).
    expect(sessionArgs.subscription_data.metadata.app).toBe('bundle');
    expect(sessionArgs.subscription_data.metadata.plan_key).toBe('veridian-pro');
  });
});
