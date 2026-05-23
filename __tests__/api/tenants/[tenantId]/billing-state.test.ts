/**
 * Tests d'intégration GET /api/tenants/[tenantId]/billing-state.
 *
 * Couvre :
 *   - 400 sur tenant_id non-UUID
 *   - 400 sur headers HMAC absents
 *   - 400 sur x-veridian-app inconnu
 *   - 401 sur signature HMAC invalide
 *   - 401 sur drift timestamp > 5 min
 *   - 503 sur secret app non configuré
 *   - 404 sur tenant inconnu
 *   - 200 nominal — shape §6.3 conforme, header X-Veridian-Cache=MISS puis HIT
 *   - 200 isolation app : notifuse caller voit notifusePlan, prospection caller voit prospectionPlan
 *   - 429 sur rate-limit (60/min/secret)
 *   - 401 sur tentative usurpation x-veridian-app (signature valable pour notifuse mais header dit prospection)
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';

const NOTIFUSE_SECRET = 'test-notifuse-hub-api-secret-32-bytes!!';
const PROSPECTION_SECRET = 'test-prospection-hub-api-secret-32B!!';
const ORIGINAL_ENV = { ...process.env };

const VALID_UUID_1 = '11111111-2222-4333-8444-555555555555';
const VALID_UUID_2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';

const tenantFindUniqueMock = vi.fn();
const tenantTrialFindUniqueMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findUnique: (...args: unknown[]) => tenantFindUniqueMock(...args),
    },
    tenantTrial: {
      findUnique: (...args: unknown[]) => tenantTrialFindUniqueMock(...args),
    },
  },
}));

function buildReq(opts: {
  tenantId?: string;
  app?: string;
  signWithSecret?: string | null;
  timestamp?: string;
  badSignature?: string;
  /**
   * Si défini, ajoute `x-veridian-e2e-bypass-ratelimit` — utilisé pour
   * tester l'intégration `billingStatePollLimiter.enforceWithBypass()`.
   */
  rateLimitBypass?: string;
}): Request {
  const ts = opts.timestamp ?? String(Date.now());
  const app = opts.app ?? 'notifuse';
  const rawBody = '';

  let signature = opts.badSignature;
  if (signature === undefined && opts.signWithSecret !== null) {
    const secret = opts.signWithSecret ?? NOTIFUSE_SECRET;
    signature = createHmac('sha256', secret)
      .update(`${ts}.${rawBody}`)
      .digest('hex');
  }

  const headers = new Headers({
    'x-veridian-app': app,
    'x-veridian-timestamp': ts,
  });
  if (signature !== undefined) {
    headers.set('x-veridian-hub-signature', signature);
  }
  if (opts.rateLimitBypass) {
    headers.set('x-veridian-e2e-bypass-ratelimit', opts.rateLimitBypass);
  }

  return new Request('https://hub.veridian.site/api/tenants/x/billing-state', {
    method: 'GET',
    headers,
  });
}

async function callRoute(
  req: Request,
  tenantIdInUrl: string = VALID_UUID_1,
): Promise<Response> {
  const { GET } = await import('@/app/api/tenants/[tenantId]/billing-state/route');
  return GET(req, { params: Promise.resolve({ tenantId: tenantIdInUrl }) });
}

beforeEach(async () => {
  vi.clearAllMocks();
  tenantFindUniqueMock.mockReset();
  tenantTrialFindUniqueMock.mockReset();

  const { billingStatePollLimiter } = await import('@/lib/auth/rate-limit');
  billingStatePollLimiter.reset();

  const { clearBillingStateCache } = await import('@/lib/billing/billing-state');
  clearBillingStateCache();

  process.env.NOTIFUSE_HUB_API_SECRET = NOTIFUSE_SECRET;
  process.env.PROSPECTION_HUB_API_SECRET = PROSPECTION_SECRET;
  delete process.env.ANALYTICS_HUB_API_SECRET;
  delete process.env.CMS_HUB_API_SECRET;
});

describe('GET /api/tenants/[tenantId]/billing-state — guards', () => {
  it('returns 400 on invalid tenant_id (not UUID)', async () => {
    const req = buildReq({});
    const res = await callRoute(req, 'not-a-uuid');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_tenant_id');
  });

  it('returns 400 when HMAC headers missing', async () => {
    const headers = new Headers({ 'x-veridian-app': 'notifuse' });
    const req = new Request('https://hub.veridian.site/x', { headers });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('unauthorized');
  });

  it('returns 400 on unknown x-veridian-app', async () => {
    const req = buildReq({ app: 'evil-app' });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('unauthorized');
    expect(json.reason).toContain('unsupported app');
  });

  it('returns 401 on invalid HMAC signature', async () => {
    const req = buildReq({ badSignature: 'a'.repeat(64) });
    const res = await callRoute(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 on drift > 5 min', async () => {
    const oldTs = String(Date.now() - 6 * 60 * 1000);
    const req = buildReq({ timestamp: oldTs });
    const res = await callRoute(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.reason).toContain('drift');
  });

  it('returns 503 when secret not configured for app', async () => {
    const req = buildReq({
      app: 'analytics',
      signWithSecret: 'unused', // 503 levé avant verify signature
    });
    const res = await callRoute(req);
    expect(res.status).toBe(503);
  });
});

describe('GET /api/tenants/[tenantId]/billing-state — resolution', () => {
  it('returns 404 when tenant unknown', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce(null);
    tenantTrialFindUniqueMock.mockResolvedValueOnce(null);
    const req = buildReq({});
    const res = await callRoute(req, UNKNOWN_UUID);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('tenant_not_found');
  });

  it('returns 200 with exact §6.3 shape — notifuse pro stripe', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID_1,
      notifusePlan: 'pro',
      prospectionPlan: 'freemium',
      metadata: {
        notifuse_plan_source: 'stripe',
        notifuse_plan_set_at: '2026-05-20T10:00:00.000Z',
      },
      updatedAt: new Date('2026-05-22T15:30:00.000Z'),
      subscription: { stripeSubscriptionId: 'sub_abc123' },
    });
    tenantTrialFindUniqueMock.mockResolvedValueOnce(null);

    const req = buildReq({});
    const res = await callRoute(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    // Shape STRICTE §6.3 — ne pas étendre sans bump contract_version
    expect(Object.keys(json).sort()).toEqual(
      [
        'effective_at',
        'plan',
        'plan_source',
        'stripe_subscription_id',
        'tenant_id',
        'updated_at',
      ].sort(),
    );
    expect(json.tenant_id).toBe(VALID_UUID_1);
    expect(json.plan).toBe('pro');
    expect(json.plan_source).toBe('stripe');
    expect(json.stripe_subscription_id).toBe('sub_abc123');
    expect(json.effective_at).toBe('2026-05-20T10:00:00.000Z');
    expect(json.updated_at).toBe('2026-05-22T15:30:00.000Z');
    expect(res.headers.get('X-Veridian-Cache')).toBe('MISS');
  });

  it('isolation app — notifuse caller voit notifusePlan, pas prospectionPlan', async () => {
    // Le tenant a notifusePlan=pro et prospectionPlan=business.
    // Caller HMAC notifuse → DOIT recevoir plan='pro' (notifuse), pas business.
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID_1,
      notifusePlan: 'pro',
      prospectionPlan: 'business',
      metadata: { notifuse_plan_source: 'stripe', prospection_plan_source: 'stripe' },
      updatedAt: new Date(),
      subscription: { stripeSubscriptionId: 'sub_z' },
    });
    tenantTrialFindUniqueMock.mockResolvedValueOnce(null);

    const req = buildReq({ app: 'notifuse' });
    const res = await callRoute(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.plan).toBe('pro');
  });

  it('isolation app — prospection caller voit business (pas pro)', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID_1,
      notifusePlan: 'pro',
      prospectionPlan: 'business',
      metadata: { notifuse_plan_source: 'stripe', prospection_plan_source: 'stripe' },
      updatedAt: new Date(),
      subscription: { stripeSubscriptionId: 'sub_z' },
    });
    tenantTrialFindUniqueMock.mockResolvedValueOnce(null);

    const req = buildReq({
      app: 'prospection',
      signWithSecret: PROSPECTION_SECRET,
    });
    const res = await callRoute(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.plan).toBe('business');
  });

  it('usurpation x-veridian-app échoue (secret désync = 401)', async () => {
    // Un attaquant qui contrôle le secret Notifuse et qui essaie de récupérer
    // l'état billing prospection en mettant x-veridian-app=prospection.
    // → la signature est calculée avec NOTIFUSE_SECRET mais Hub vérifie
    //   avec PROSPECTION_SECRET (résolu depuis le header app=prospection)
    //   → 401 invalid signature. Protection §6.1.
    const ts = String(Date.now());
    const sig = createHmac('sha256', NOTIFUSE_SECRET)
      .update(`${ts}.`)
      .digest('hex');
    const headers = new Headers({
      'x-veridian-app': 'prospection',
      'x-veridian-timestamp': ts,
      'x-veridian-hub-signature': sig,
    });
    const req = new Request('https://hub.veridian.site/x', { headers });
    const res = await callRoute(req);
    expect(res.status).toBe(401);
  });

  it('cache HIT sur 2e appel (header X-Veridian-Cache=HIT)', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID_1,
      notifusePlan: 'pro',
      prospectionPlan: 'freemium',
      metadata: { notifuse_plan_source: 'stripe' },
      updatedAt: new Date('2026-05-22T15:30:00.000Z'),
      subscription: { stripeSubscriptionId: 'sub_abc' },
    });
    tenantTrialFindUniqueMock.mockResolvedValueOnce(null);

    const r1 = await callRoute(buildReq({}));
    expect(r1.status).toBe(200);
    expect(r1.headers.get('X-Veridian-Cache')).toBe('MISS');

    // 2e appel — pas de mock re-armé. Si le cache ne marche pas, le 2e
    // call hit DB qui renvoie undefined → 404/500.
    const r2 = await callRoute(buildReq({}));
    expect(r2.status).toBe(200);
    expect(r2.headers.get('X-Veridian-Cache')).toBe('HIT');
    expect(tenantFindUniqueMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/tenants/[tenantId]/billing-state — rate-limit', () => {
  it('returns 429 after 60 requests/min on the same secret', async () => {
    // On varie tenant_id pour pas hit le cache (sinon le rate-limit reste
    // valide mais on saute la DB — l'objectif est de saturer le bucket).
    tenantFindUniqueMock.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      notifusePlan: 'pro',
      prospectionPlan: 'freemium',
      metadata: { notifuse_plan_source: 'stripe' },
      updatedAt: new Date(),
      subscription: { stripeSubscriptionId: 'sub_x' },
    }));
    tenantTrialFindUniqueMock.mockResolvedValue(null);

    for (let i = 0; i < 60; i++) {
      // Varie un caractère du UUID pour avoir 60 tenants distincts
      const hexChar = (i % 16).toString(16);
      const tid = `11111111-2222-4333-8444-555555555${hexChar.repeat(3)}`;
      const r = await callRoute(buildReq({}), tid);
      expect(r.status).toBe(200);
    }
    const r61 = await callRoute(buildReq({}), VALID_UUID_2);
    expect(r61.status).toBe(429);
    expect(r61.headers.get('Retry-After')).toBeTruthy();
  });
});

// ─── Bypass E2E rate-limit (passage à enforceWithBypass) ─────────────────
// GET /api/tenants/[tenantId]/billing-state utilise désormais
// `billingStatePollLimiter.enforceWithBypass('app:notifuse', headers)`.
describe('GET /api/tenants/[tenantId]/billing-state — bypass E2E header', () => {
  const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
  const ORIG_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;
  const BYPASS = 'b'.repeat(48);

  beforeEach(() => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.E2E_RATELIMIT_BYPASS_SECRET = BYPASS;
    tenantFindUniqueMock.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      notifusePlan: 'pro',
      prospectionPlan: 'freemium',
      metadata: { notifuse_plan_source: 'stripe' },
      updatedAt: new Date(),
      subscription: { stripeSubscriptionId: 'sub_x' },
    }));
    tenantTrialFindUniqueMock.mockResolvedValue(null);
  });

  afterAll(() => {
    if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
    else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
    if (ORIG_SECRET === undefined) delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_SECRET;
  });

  it('bypass header valide en staging → 100+ poll sans 429', async () => {
    for (let i = 0; i < 100; i++) {
      const hexChar = (i % 16).toString(16);
      const tid = `22222222-3333-4444-8555-666666666${hexChar.repeat(3)}`;
      const r = await callRoute(
        buildReq({ rateLimitBypass: BYPASS }),
        tid,
      );
      expect(r.status, `req #${i} should bypass (got ${r.status})`).toBe(200);
    }
  });

  it('GARDE-FOU PROD : bypass header ignoré, 429 quand cap dépassé', async () => {
    process.env.DEPLOY_ENV = 'prod';
    for (let i = 0; i < 60; i++) {
      const hexChar = (i % 16).toString(16);
      const tid = `33333333-4444-4555-8666-777777777${hexChar.repeat(3)}`;
      const r = await callRoute(
        buildReq({ rateLimitBypass: BYPASS }),
        tid,
      );
      expect(r.status).toBe(200);
    }
    const blocked = await callRoute(
      buildReq({ rateLimitBypass: BYPASS }),
      VALID_UUID_2,
    );
    expect(blocked.status, 'PROD MUST ignore bypass header').toBe(429);
  });
});

afterAll(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});
