/**
 * Tests pour POST /api/admin/tenant-billing-state
 *
 * Couvre :
 *  - authenticateAdmin guard
 *  - 400 si JSON / payload invalide
 *  - 404 si tenant_not_found
 *  - 500 si unknown_plan (corrupted local plan)
 *  - 200 + shape `{ok, response, cached}` si OK
 *  - 400 si app non whitelisté
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authenticateAdminMock = vi.fn();
const getBillingStateMock = vi.fn();

vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: (...args: unknown[]) => authenticateAdminMock(...args),
}));
vi.mock('@/lib/billing/billing-state', () => ({
  getBillingState: (...args: unknown[]) => getBillingStateMock(...args),
}));

beforeEach(() => {
  authenticateAdminMock.mockReset();
  getBillingStateMock.mockReset();
});

// UUID v4 valide (zod >= 3.22 vérifie le format version)
const validTenantId = '550e8400-e29b-41d4-a716-446655440000';
const makeReq = (body: unknown) =>
  new Request('http://x/api/admin/tenant-billing-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const authOK = { ok: true, sessionEmail: null };
const authDenied = {
  ok: false,
  response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
};

describe('POST /api/admin/tenant-billing-state', () => {
  it('renvoie le denyResponse de authenticateAdmin si non autorisé', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied);
    const { POST } = await import('@/app/api/admin/tenant-billing-state/route');
    const res = await POST(
      makeReq({ tenantId: validTenantId, app: 'notifuse' }) as never,
    );
    expect(res.status).toBe(401);
    expect(getBillingStateMock).not.toHaveBeenCalled();
  });

  it('400 si JSON invalide', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    const { POST } = await import('@/app/api/admin/tenant-billing-state/route');
    const res = await POST(makeReq('garbage') as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_json');
  });

  it('400 si tenantId pas UUID', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    const { POST } = await import('@/app/api/admin/tenant-billing-state/route');
    const res = await POST(makeReq({ tenantId: 'not-uuid', app: 'notifuse' }) as never);
    expect(res.status).toBe(400);
  });

  it('400 si app non whitelisté', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    const { POST } = await import('@/app/api/admin/tenant-billing-state/route');
    const res = await POST(
      makeReq({ tenantId: validTenantId, app: 'unknown-app' }) as never,
    );
    expect(res.status).toBe(400);
  });

  it('404 si tenant_not_found', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    getBillingStateMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'tenant_not_found' },
    });
    const { POST } = await import('@/app/api/admin/tenant-billing-state/route');
    const res = await POST(
      makeReq({ tenantId: validTenantId, app: 'notifuse' }) as never,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('tenant_not_found');
  });

  it('500 si unknown_plan', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    getBillingStateMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown_plan', details: 'plan="??"' },
    });
    const { POST } = await import('@/app/api/admin/tenant-billing-state/route');
    const res = await POST(
      makeReq({ tenantId: validTenantId, app: 'prospection' }) as never,
    );
    expect(res.status).toBe(500);
  });

  it('200 + shape {ok, response, cached} si OK', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    getBillingStateMock.mockResolvedValueOnce({
      ok: true,
      response: {
        tenant_id: validTenantId,
        plan: 'pro',
        plan_source: 'stripe',
        stripe_subscription_id: 'sub_xyz',
        effective_at: '2026-05-24T00:00:00.000Z',
        updated_at: '2026-05-24T00:00:00.000Z',
      },
      cached: false,
    });
    const { POST } = await import('@/app/api/admin/tenant-billing-state/route');
    const res = await POST(
      makeReq({ tenantId: validTenantId, app: 'notifuse' }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.response.plan).toBe('pro');
    expect(body.cached).toBe(false);
    expect(getBillingStateMock).toHaveBeenCalledWith(validTenantId, 'notifuse');
  });
});
