/**
 * Tests des routes admin Notifuse Hub :
 * - POST /api/admin/notifuse/update-plan
 * - POST /api/admin/notifuse/suspend
 * - POST /api/admin/notifuse/resume
 * - DELETE /api/admin/notifuse/delete
 * - GET   /api/admin/notifuse/status
 *
 * On mock `auth`, `isPlatformAdmin`, `prisma` et `fetch` (utilisé par
 * NotifuseClient en interne) pour valider la logique métier sans DB ni réseau.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => ({ user: { email: 'brunon5robert@gmail.com' } })),
}));

vi.mock('@/lib/admin/check-admin', () => ({
  isPlatformAdmin: vi.fn(() => true),
}));

const tenantStore: Map<string, any> = new Map();
const provisioningLogs: any[] = [];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findUnique: vi.fn(async ({ where }: any) => tenantStore.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const cur = tenantStore.get(where.id);
        if (!cur) throw new Error('Tenant not found in store');
        const merged = { ...cur, ...data };
        tenantStore.set(where.id, merged);
        return merged;
      }),
    },
    provisioningLog: {
      create: vi.fn(async ({ data }: any) => {
        provisioningLogs.push(data);
        return { id: `log_${provisioningLogs.length}`, ...data };
      }),
    },
  },
}));

// Mock global fetch — interceptera tous les appels du NotifuseClient.
const fetchMock = vi.fn();

// ============================================================================
// Helpers
// ============================================================================

function makeNextRequest(opts: {
  url?: string;
  method: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}): any {
  const url = opts.url ?? 'http://localhost/api/admin/notifuse/test';
  const headers = new Map<string, string>(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const parsed = new URL(url);
  return {
    url,
    method: opts.method,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    nextUrl: {
      searchParams: parsed.searchParams,
    },
    json: async () => {
      if (opts.body === undefined) throw new Error('No body');
      return opts.body;
    },
    text: async () => (opts.body === undefined ? '' : JSON.stringify(opts.body)),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TENANT_ID = 'tenant_abc';
const NOTIFUSE_SLUG = 'demoorg';

function seedTenant(extra: Record<string, unknown> = {}) {
  tenantStore.set(TENANT_ID, {
    id: TENANT_ID,
    notifuseWorkspaceSlug: NOTIFUSE_SLUG,
    notifuseUserEmail: 'owner@example.com',
    notifuseApiKey: 'nf_key_demo',
    metadata: extra,
  });
}

// ============================================================================
// Setup env + global fetch
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  tenantStore.clear();
  provisioningLogs.length = 0;
  process.env.NOTIFUSE_API_URL = 'https://notifuse.example.com';
  process.env.NOTIFUSE_HUB_API_SECRET = 'test-hub-secret';
  process.env.ADMIN_SECRET = 'test-admin-secret';
  // @ts-expect-error — override global fetch for tests
  global.fetch = fetchMock;
});

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/admin/notifuse/update-plan', () => {
  it('renvoie 401 sans session ni admin secret', async () => {
    const { auth } = await import('@/auth');
    (auth as any).mockResolvedValueOnce(null);

    const { POST } = await import('@/app/api/admin/notifuse/update-plan/route');
    const req = makeNextRequest({
      method: 'POST',
      body: { tenantId: TENANT_ID, plan: 'pro' },
    });
    const res: any = await POST(req);
    expect(res.status).toBe(401);
  });

  it('accepte un appel via x-admin-secret header (sans session)', async () => {
    const { auth } = await import('@/auth');
    (auth as any).mockResolvedValueOnce(null);
    seedTenant();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const { POST } = await import('@/app/api/admin/notifuse/update-plan/route');
    const req = makeNextRequest({
      method: 'POST',
      headers: { 'x-admin-secret': 'test-admin-secret' },
      body: { tenantId: TENANT_ID, plan: 'pro' },
    });
    const res: any = await POST(req);
    expect(res.status).toBe(200);
  });

  it('rejette un plan invalide', async () => {
    seedTenant();
    const { POST } = await import('@/app/api/admin/notifuse/update-plan/route');
    const req = makeNextRequest({
      method: 'POST',
      body: { tenantId: TENANT_ID, plan: 'platinum' },
    });
    const res: any = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/plan must be one of/);
  });

  it('rejette si tenant introuvable', async () => {
    const { POST } = await import('@/app/api/admin/notifuse/update-plan/route');
    const req = makeNextRequest({
      method: 'POST',
      body: { tenantId: 'unknown', plan: 'pro' },
    });
    const res: any = await POST(req);
    expect(res.status).toBe(404);
  });

  it('rejette si workspace Notifuse pas provisionné', async () => {
    tenantStore.set(TENANT_ID, {
      id: TENANT_ID,
      notifuseWorkspaceSlug: null,
      metadata: {},
    });

    const { POST } = await import('@/app/api/admin/notifuse/update-plan/route');
    const req = makeNextRequest({
      method: 'POST',
      body: { tenantId: TENANT_ID, plan: 'pro' },
    });
    const res: any = await POST(req);
    expect(res.status).toBe(409);
  });

  it('appelle NotifuseClient.updatePlan avec le bon body et persiste l audit', async () => {
    seedTenant({ notifuse_plan: 'free' });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const { POST } = await import('@/app/api/admin/notifuse/update-plan/route');
    const req = makeNextRequest({
      method: 'POST',
      body: {
        tenantId: TENANT_ID,
        plan: 'lifetime_site_vitrine',
        planSource: 'lifetime_site_vitrine',
        reason: 'gift_site_vitrine',
      },
    });
    const res: any = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan).toBe('lifetime_site_vitrine');
    expect(body.plan_source).toBe('lifetime_site_vitrine');

    // Le NotifuseClient a bien envoyé la requête
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://notifuse.example.com/api/tenants/update-plan');
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody).toEqual({ tenant_id: NOTIFUSE_SLUG, plan: 'lifetime_site_vitrine' });

    // L'audit a été persisté dans tenant.metadata
    const tenant = tenantStore.get(TENANT_ID);
    expect(tenant.metadata.notifuse_plan).toBe('lifetime_site_vitrine');
    expect(tenant.metadata.notifuse_plan_source).toBe('lifetime_site_vitrine');
    expect(tenant.metadata.notifuse_plan_history).toHaveLength(1);
    expect(tenant.metadata.notifuse_plan_history[0]).toMatchObject({
      plan: 'lifetime_site_vitrine',
      previous_plan: 'free',
      reason: 'gift_site_vitrine',
      set_by: 'brunon5robert@gmail.com',
    });

    expect(provisioningLogs).toHaveLength(1);
    expect(provisioningLogs[0].service).toBe('notifuse');
  });

  it('propage l erreur Notifuse en 502 si Go renvoie 5xx', async () => {
    seedTenant();
    fetchMock.mockResolvedValue(jsonResponse(503, { error: 'service unavailable' }));

    const { POST } = await import('@/app/api/admin/notifuse/update-plan/route');
    const req = makeNextRequest({
      method: 'POST',
      body: { tenantId: TENANT_ID, plan: 'pro' },
    });
    const res: any = await POST(req);
    // NotifuseClient a 2 retries puis throw NotifuseError(503)
    expect(res.status).toBe(503);
  });
});

describe('POST /api/admin/notifuse/suspend', () => {
  it('rejette sans reason', async () => {
    seedTenant();
    const { POST } = await import('@/app/api/admin/notifuse/suspend/route');
    const req = makeNextRequest({
      method: 'POST',
      body: { tenantId: TENANT_ID },
    });
    const res: any = await POST(req);
    expect(res.status).toBe(400);
  });

  it('appelle NotifuseClient.suspendWorkspace et persiste les marqueurs', async () => {
    seedTenant();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const { POST } = await import('@/app/api/admin/notifuse/suspend/route');
    const req = makeNextRequest({
      method: 'POST',
      body: { tenantId: TENANT_ID, reason: 'payment_failed' },
    });
    const res: any = await POST(req);
    expect(res.status).toBe(200);

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://notifuse.example.com/api/tenants/suspend');
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody).toEqual({ tenant_id: NOTIFUSE_SLUG, reason: 'payment_failed' });

    const tenant = tenantStore.get(TENANT_ID);
    expect(tenant.metadata.notifuse_suspended_reason).toBe('payment_failed');
    expect(tenant.metadata.notifuse_suspended_at).toBeTruthy();
    expect(tenant.metadata.notifuse_suspended_by).toBe('brunon5robert@gmail.com');
  });
});

describe('POST /api/admin/notifuse/resume', () => {
  it('clear suspension markers', async () => {
    seedTenant({
      notifuse_suspended_at: '2026-01-01T00:00:00Z',
      notifuse_suspended_reason: 'payment_failed',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const { POST } = await import('@/app/api/admin/notifuse/resume/route');
    const req = makeNextRequest({
      method: 'POST',
      body: { tenantId: TENANT_ID },
    });
    const res: any = await POST(req);
    expect(res.status).toBe(200);

    const tenant = tenantStore.get(TENANT_ID);
    expect(tenant.metadata.notifuse_suspended_at).toBeNull();
    expect(tenant.metadata.notifuse_suspended_reason).toBeNull();
    expect(tenant.metadata.notifuse_resumed_at).toBeTruthy();
  });
});

describe('DELETE /api/admin/notifuse/delete', () => {
  it('exige confirm: true', async () => {
    seedTenant();
    const { DELETE } = await import('@/app/api/admin/notifuse/delete/route');
    const req = makeNextRequest({
      method: 'DELETE',
      body: { tenantId: TENANT_ID },
    });
    const res: any = await DELETE(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/confirm/);
  });

  it('soft-delete via NotifuseClient et persiste deleted_at', async () => {
    seedTenant();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const { DELETE } = await import('@/app/api/admin/notifuse/delete/route');
    const req = makeNextRequest({
      method: 'DELETE',
      body: { tenantId: TENANT_ID, confirm: true },
    });
    const res: any = await DELETE(req);
    expect(res.status).toBe(200);

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`https://notifuse.example.com/api/tenants/${NOTIFUSE_SLUG}`);
    expect((init as RequestInit).method).toBe('DELETE');

    const tenant = tenantStore.get(TENANT_ID);
    expect(tenant.metadata.notifuse_deleted_at).toBeTruthy();
  });
});

describe('GET /api/admin/notifuse/status', () => {
  it('exige tenantId en query', async () => {
    const { GET } = await import('@/app/api/admin/notifuse/status/route');
    const req = makeNextRequest({
      method: 'GET',
      url: 'http://localhost/api/admin/notifuse/status',
    });
    const res: any = await GET(req);
    expect(res.status).toBe(400);
  });

  it('proxy le payload status du fork Notifuse', async () => {
    seedTenant();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        tenant_id: NOTIFUSE_SLUG,
        status: 'active',
        plan: 'pro',
        monthly_email_quota: 10000,
        emails_sent_this_month: 42,
        quota_remaining: 9958,
      }),
    );

    const { GET } = await import('@/app/api/admin/notifuse/status/route');
    const req = makeNextRequest({
      method: 'GET',
      url: `http://localhost/api/admin/notifuse/status?tenantId=${TENANT_ID}`,
    });
    const res: any = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(body.plan).toBe('pro');
    expect(body.monthly_email_quota).toBe(10000);
    expect(body.notifuse_workspace_id).toBe(NOTIFUSE_SLUG);
  });
});
