/**
 * Tests POST /api/billing/refill-leads/checkout
 *
 * Couvre :
 *  1. 401 si pas authentifié
 *  2. 400 si JSON invalide / payload schéma invalide
 *  3. 400 si quantity hors borne (0, > 100000)
 *  4. 404 si tenant introuvable ou pas owner (sécu horizontale critique)
 *  5. 503 si STRIPE_REFILL_PRODUCT_ID absent (env)
 *  6. 502 si Stripe API fail
 *  7. 200 + URL si tout OK, metadata.kind='refill_leads' propagée
 *  8. Mapping plan : tenant.prospectionPlan='pro' → tier 'pro' utilisé pour le prix
 *  9. Plan inconnu / null → fallback freemium
 * 10. Rate-limit : 6e requête de la même IP en 1 minute → 429
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
  resolveStripeCustomerId: vi.fn(async () => 'cus_test_refill'),
}));

let mockUser: any = {
  id: 'u1',
  email: 'buyer@veridian.site',
  supabaseUserId: 'uuid-buyer',
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

const tenantFindFirstMock = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: { findFirst: (...a: any[]) => tenantFindFirstMock(...a) },
  },
}));

// Mock env.getStripeRefillProductId pour contrôler 503
let mockProductId: string | null = 'prod_refill_test_xxx';
vi.mock('@/utils/env', async () => {
  const actual = await vi.importActual<typeof import('@/utils/env')>('@/utils/env');
  return {
    ...actual,
    getStripeRefillProductId: vi.fn(() => {
      if (!mockProductId) {
        throw new Error('STRIPE_REFILL_PRODUCT_ID_TEST non configuré');
      }
      return mockProductId;
    }),
  };
});

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(async () => {
  vi.clearAllMocks();
  mockUser = { id: 'u1', email: 'buyer@veridian.site', supabaseUserId: 'uuid-buyer' };
  mockProductId = 'prod_refill_test_xxx';
  sessionsCreateMock.mockReset();
  tenantFindFirstMock.mockReset();
  tenantFindFirstMock.mockResolvedValue({ id: TENANT_ID, prospectionPlan: 'freemium' });

  // Reset rate limiter (in-memory) entre les tests pour ne pas contaminer
  const { POST: _ } = await import('@/app/api/billing/refill-leads/checkout/route');
  // Le limiter est interne au module — on relance le module entier en
  // resettant `vi.resetModules()` pour avoir un état propre à chaque test.
});

function makeReq(body: any, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: new Headers({ 'x-forwarded-for': '127.0.0.1', ...headers }),
  } as any;
}

describe('POST /api/billing/refill-leads/checkout', () => {
  beforeEach(() => {
    // Cleanup module-level rate limiter
    vi.resetModules();
  });

  it('returns 401 if not authenticated', async () => {
    mockUser = null;
    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const res = await POST(makeReq({ tenantId: TENANT_ID, quantity: 100 }));
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid JSON', async () => {
    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const req = {
      json: async () => { throw new Error('bad'); },
      headers: new Headers({ 'x-forwarded-for': '1.1.1.1' }),
    } as any;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 on missing tenantId', async () => {
    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const res = await POST(makeReq({ quantity: 100 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
  });

  it('returns 400 on quantity = 0', async () => {
    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const res = await POST(makeReq({ tenantId: TENANT_ID, quantity: 0 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on quantity > 100000', async () => {
    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const res = await POST(makeReq({ tenantId: TENANT_ID, quantity: 200_000 }));
    expect(res.status).toBe(400);
  });

  it('returns 404 if tenant not found OR not owned by user (horizontal sec)', async () => {
    tenantFindFirstMock.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const res = await POST(makeReq({ tenantId: TENANT_ID, quantity: 100 }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('tenant_not_found_or_forbidden');
  });

  it('returns 503 if STRIPE_REFILL_PRODUCT_ID missing', async () => {
    mockProductId = null;
    tenantFindFirstMock.mockResolvedValueOnce({ id: TENANT_ID, prospectionPlan: 'freemium' });
    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const res = await POST(makeReq({ tenantId: TENANT_ID, quantity: 100 }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('stripe_product_not_configured');
  });

  it('returns 502 if Stripe API fails', async () => {
    sessionsCreateMock.mockRejectedValueOnce(new Error('Stripe down'));
    tenantFindFirstMock.mockResolvedValueOnce({ id: TENANT_ID, prospectionPlan: 'freemium' });
    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const res = await POST(makeReq({ tenantId: TENANT_ID, quantity: 100 }));
    expect(res.status).toBe(502);
  });

  it('returns 200 + URL with correct metadata.kind=refill_leads + price calculated from grille', async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      id: 'cs_refill_xyz',
      url: 'https://checkout.stripe.com/c/refill',
    });
    tenantFindFirstMock.mockResolvedValueOnce({ id: TENANT_ID, prospectionPlan: 'pro' });
    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const res = await POST(makeReq({ tenantId: TENANT_ID, quantity: 500 }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.url).toContain('checkout.stripe.com');
    expect(body.amount_cents).toBe(12_500); // pro × 500 = 25c × 500
    expect(body.tier).toBe('pro');
    expect(body.quantity).toBe(500);

    const args = sessionsCreateMock.mock.calls[0][0];
    expect(args.mode).toBe('payment');
    expect(args.metadata.kind).toBe('refill_leads');
    expect(args.metadata.app).toBe('prospection');
    expect(args.metadata.hub_tenant_id).toBe(TENANT_ID);
    expect(args.metadata.owner_email).toBe('buyer@veridian.site');
    expect(args.metadata.quantity).toBe('500');
    expect(args.metadata.refill_tier).toBe('pro');

    expect(args.line_items[0].quantity).toBe(1);
    expect(args.line_items[0].price_data.product).toBe('prod_refill_test_xxx');
    expect(args.line_items[0].price_data.unit_amount).toBe(12_500);
    expect(args.line_items[0].price_data.currency).toBe('eur');

    // payment_intent_data.metadata est dupliqué pour traçabilité Stripe Dashboard
    expect(args.payment_intent_data.metadata.kind).toBe('refill_leads');
  });

  it('fallback freemium si tenant.prospectionPlan est null', async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      id: 'cs_x',
      url: 'https://checkout.stripe.com/c/x',
    });
    tenantFindFirstMock.mockResolvedValueOnce({ id: TENANT_ID, prospectionPlan: null });
    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const res = await POST(makeReq({ tenantId: TENANT_ID, quantity: 50 }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tier).toBe('freemium');
    expect(body.amount_cents).toBe(2500); // freemium × 50 = 50c × 50
  });

  it('fallback freemium si tenant.prospectionPlan est inconnu (ex: "vip")', async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      id: 'cs_y',
      url: 'https://checkout.stripe.com/c/y',
    });
    tenantFindFirstMock.mockResolvedValueOnce({ id: TENANT_ID, prospectionPlan: 'vip' });
    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const res = await POST(makeReq({ tenantId: TENANT_ID, quantity: 50 }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tier).toBe('freemium');
  });

  it('rate-limit : 6e requête de la même IP en 1 minute → 429', async () => {
    sessionsCreateMock.mockResolvedValue({
      id: 'cs_rate',
      url: 'https://checkout.stripe.com/c/rate',
    });
    tenantFindFirstMock.mockResolvedValue({ id: TENANT_ID, prospectionPlan: 'freemium' });

    const { POST } = await import('@/app/api/billing/refill-leads/checkout/route');
    const ip = '9.9.9.9';

    // 5 requêtes OK
    for (let i = 0; i < 5; i++) {
      const res = await POST(makeReq({ tenantId: TENANT_ID, quantity: 10 }, { 'x-forwarded-for': ip }));
      expect(res.status).toBe(200);
    }

    // 6e → bloquée
    const res6 = await POST(makeReq({ tenantId: TENANT_ID, quantity: 10 }, { 'x-forwarded-for': ip }));
    expect(res6.status).toBe(429);
    const body = await res6.json();
    expect(body.error).toBe('rate_limited');
  });
});
