/**
 * Tests POST /api/billing/refill-leads/checkout-from-app
 *
 * Variante HMAC-authentifiée de /checkout (cf ticket
 * 2026-05-25-refill-checkout-from-app-hmac-route.md).
 *
 * Couvre les 10 cas demandés par le ticket §4 :
 *   1. 401 sans HMAC
 *   2. 401 HMAC valid mais app non whitelistée (ex notifuse)
 *   3. 400 body invalid
 *   4. 404 tenant_not_found
 *   5. 200 sans filters_json (backward compat — pas de filters dans metadata)
 *   6. 200 avec filters_json valide (forward dans metadata Stripe)
 *   7. 200 avec filters_json > 500 chars (truncate + warning log)
 *   8. 503 si Stripe pas configuré
 *   9. 422 si Stripe API fail
 *  10. 403 si app authentifiée mais non whitelistée (HMAC OK + app=notifuse)
 *
 * NB sur cas 1 vs 2 vs 10 : le ticket parle de 401 "HMAC valid mais app non
 * whitelistée" — sémantiquement c'est 403 (l'auth est valide, c'est
 * l'autorisation qui échoue). On rend `403 app_not_whitelisted` mais on
 * couvre les deux côtés (manque header → 400/401 selon le helper).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

const TEST_SECRET = 'prospection-hub-shared-secret-for-tests-1234567890';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const sessionsCreateMock = vi.fn();
vi.mock('@/utils/stripe/config', () => ({
  stripe: {
    checkout: {
      sessions: { create: (...args: any[]) => sessionsCreateMock(...args) },
    },
  },
}));

vi.mock('@/utils/stripe/server', () => ({
  resolveStripeCustomerId: vi.fn(async () => 'cus_test_refill_app'),
}));

const tenantFindFirstMock = vi.fn();
const userFindFirstMock = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: { findFirst: (...a: any[]) => tenantFindFirstMock(...a) },
    user: { findFirst: (...a: any[]) => userFindFirstMock(...a) },
  },
}));

let mockProductId: string | null = 'prod_refill_test_app';
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_UUID = '22222222-2222-4222-8222-222222222222';
const OWNER_EMAIL = 'owner@example.com';

function signHmac(rawBody: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function makeRequest(
  bodyObj: unknown,
  opts: {
    app?: string;
    secret?: string;
    timestamp?: string;
    omitHmac?: boolean;
    rawOverride?: string;
  } = {},
): Request {
  const rawBody = opts.rawOverride ?? JSON.stringify(bodyObj);
  const timestamp = opts.timestamp ?? Date.now().toString();
  const app = opts.app ?? 'prospection';
  const secret = opts.secret ?? TEST_SECRET;
  const signature = signHmac(rawBody, timestamp, secret);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (!opts.omitHmac) {
    headers['x-veridian-app'] = app;
    headers['x-veridian-timestamp'] = timestamp;
    headers['x-veridian-hub-signature'] = signature;
  }

  return new Request(
    'https://hub.veridian.site/api/billing/refill-leads/checkout-from-app',
    { method: 'POST', headers, body: rawBody },
  );
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT_ID,
    quantity: 500,
    plan: 'pro',
    contract_version: '2.1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.PROSPECTION_HUB_API_SECRET = TEST_SECRET;
  process.env.NOTIFUSE_HUB_API_SECRET = TEST_SECRET;
  mockProductId = 'prod_refill_test_app';
  sessionsCreateMock.mockReset();
  tenantFindFirstMock.mockReset();
  userFindFirstMock.mockReset();

  tenantFindFirstMock.mockResolvedValue({
    id: TENANT_ID,
    userId: USER_UUID,
    prospectionPlan: 'pro',
  });
  userFindFirstMock.mockResolvedValue({
    id: 'cuid-owner',
    email: OWNER_EMAIL,
    supabaseUserId: USER_UUID,
  });
});

describe('POST /api/billing/refill-leads/checkout-from-app', () => {
  it('returns 400 if HMAC headers missing entirely', async () => {
    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody(), { omitHmac: true });
    const res = await POST(req);
    expect([400, 401]).toContain(res.status);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 if HMAC signature is invalid (wrong secret)', async () => {
    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody(), { secret: 'wrong-secret' });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('returns 403 if HMAC valid but app not whitelisted (notifuse)', async () => {
    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody(), { app: 'notifuse' });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('app_not_whitelisted');
  });

  it('returns 400 on invalid body (missing required field)', async () => {
    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest({
      tenant_id: TENANT_ID,
      // missing quantity, plan, contract_version
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
  });

  it('returns 400 if contract_version != "2.1"', async () => {
    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody({ contract_version: '2.0' }));
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 if quantity out of bounds', async () => {
    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody({ quantity: 0 }));
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 if tenant not found', async () => {
    tenantFindFirstMock.mockResolvedValueOnce(null);
    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody());
    const res = await POST(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('tenant_not_found');
  });

  it('returns 200 WITHOUT filters_json — backward compat (no filters in metadata)', async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      id: 'cs_app_xyz',
      url: 'https://checkout.stripe.com/c/app',
    });

    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody({ quantity: 500, plan: 'pro' }));
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.url).toBe('https://checkout.stripe.com/c/app');
    expect(body.sessionId).toBe('cs_app_xyz');
    expect(body.amount_cents).toBe(12_500); // pro × 500
    expect(body.tier).toBe('pro');
    expect(body.quantity).toBe(500);

    const args = sessionsCreateMock.mock.calls[0][0];
    expect(args.metadata.kind).toBe('refill_leads');
    expect(args.metadata.app).toBe('prospection');
    expect(args.metadata.hub_tenant_id).toBe(TENANT_ID);
    expect(args.metadata.contract_version).toBe('2.1');
    expect(args.metadata.initiated_from).toBe('app');
    // Backward compat critique : pas de filters_json dans metadata
    expect(args.metadata.filters_json).toBeUndefined();
  });

  it('returns 200 WITH valid filters_json — forwards JSON serialized in metadata Stripe', async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      id: 'cs_app_filters',
      url: 'https://checkout.stripe.com/c/filters',
    });

    const filters = {
      industry: ['saas', 'fintech'],
      country: 'FR',
      headcount_min: 10,
      headcount_max: 200,
    };

    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody({ filters_json: filters }));
    const res = await POST(req);
    expect(res.status).toBe(200);

    const args = sessionsCreateMock.mock.calls[0][0];
    expect(args.metadata.filters_json).toBeDefined();
    expect(JSON.parse(args.metadata.filters_json)).toEqual(filters);
  });

  it('returns 200 with filters_json > 500 chars — truncates + emits warning log', async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      id: 'cs_huge_filters',
      url: 'https://checkout.stripe.com/c/huge',
    });

    // Construit un payload > 500 chars (large array of strings)
    const filters: Record<string, unknown> = {
      industries: Array.from({ length: 60 }, (_, i) => `industry-${i}`),
    };
    const serialized = JSON.stringify(filters);
    expect(serialized.length).toBeGreaterThan(500);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody({ filters_json: filters }));
    const res = await POST(req);
    expect(res.status).toBe(200);

    const args = sessionsCreateMock.mock.calls[0][0];
    expect(args.metadata.filters_json.length).toBe(500);

    // Warning log structuré
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    const truncateWarn = warnCalls.find((m) => m.includes('filters_truncate'));
    expect(truncateWarn).toBeDefined();
    expect(truncateWarn).toContain('truncated for Stripe metadata');

    warnSpy.mockRestore();
  });

  it('returns 503 if Stripe Product not configured', async () => {
    mockProductId = null;
    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody());
    const res = await POST(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('stripe_not_configured');
  });

  it('returns 422 if Stripe session creation fails', async () => {
    sessionsCreateMock.mockRejectedValueOnce(new Error('Stripe down'));
    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody());
    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('stripe_session_failed');
  });

  it('returns 503 if PROSPECTION_HUB_API_SECRET env missing', async () => {
    delete process.env.PROSPECTION_HUB_API_SECRET;
    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody());
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it('returns 401 if HMAC timestamp drift > 5min', async () => {
    const oldTs = (Date.now() - 6 * 60 * 1000).toString();
    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody(), { timestamp: oldTs });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('uses owner_email from User lookup (not from body)', async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      id: 'cs_x',
      url: 'https://checkout.stripe.com/c/x',
    });
    userFindFirstMock.mockResolvedValueOnce({
      id: 'cuid-x',
      email: 'real-owner@example.com',
      supabaseUserId: USER_UUID,
    });

    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(validBody());
    const res = await POST(req);
    expect(res.status).toBe(200);

    const args = sessionsCreateMock.mock.calls[0][0];
    expect(args.metadata.owner_email).toBe('real-owner@example.com');
  });

  it('forwards success_url / cancel_url if provided', async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      id: 'cs_url',
      url: 'https://checkout.stripe.com/c/url',
    });

    const { POST } = await import(
      '@/app/api/billing/refill-leads/checkout-from-app/route'
    );
    const req = makeRequest(
      validBody({
        success_url: 'https://prospection.veridian.site/refill/success',
        cancel_url: 'https://prospection.veridian.site/refill/cancel',
      }),
    );
    const res = await POST(req);
    expect(res.status).toBe(200);

    const args = sessionsCreateMock.mock.calls[0][0];
    expect(args.success_url).toBe(
      'https://prospection.veridian.site/refill/success',
    );
    expect(args.cancel_url).toBe(
      'https://prospection.veridian.site/refill/cancel',
    );
  });
});
