/**
 * Test pour POST /api/admin/tenants/[id]/plan — endpoint admin unifié
 * (Robert 2026-05-18).
 *
 * Vérifie :
 *   1. 403 si non-admin.
 *   2. 400 si app invalide.
 *   3. 400 si plan invalide pour l'app cible.
 *   4. 404 si tenant introuvable.
 *   5. Notifuse : pousse à updatePlan() Notifuse + écrit notifusePlan DB.
 *   6. Prospection : DB seule, retourne warning sur HMAC manquant.
 *   7. trialEndsAt: null → remet le champ à null.
 *   8. 409 si Notifuse workspace pas provisionné.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let adminDenial: any = null;
vi.mock('@/lib/admin/require-admin', () => ({
  requireAdmin: vi.fn(async () => adminDenial),
}));

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => ({ user: { email: 'admin@veridian.site' } })),
}));

const updatePlanMock = vi.fn(async () => undefined);
vi.mock('@/lib/notifuse/admin-helpers', () => ({
  buildNotifuseClient: vi.fn(() => ({
    updatePlan: updatePlanMock,
  })),
}));

let tenantRow: any = null;
const updateTenantMock = vi.fn(async ({ data, select }: any) => ({
  id: tenantRow?.id,
  notifusePlan: data.notifusePlan ?? tenantRow?.notifusePlan,
  prospectionPlan: data.prospectionPlan ?? tenantRow?.prospectionPlan,
  trialEndsAt: data.trialEndsAt !== undefined ? data.trialEndsAt : tenantRow?.trialEndsAt,
  ...(select ? {} : {}),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findUnique: vi.fn(async () => tenantRow),
      update: (...args: any[]) => updateTenantMock(...args),
    },
    provisioningLog: {
      create: vi.fn(async () => ({})),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  adminDenial = null;
  tenantRow = {
    id: 't-1',
    notifuseWorkspaceSlug: 'ws-1',
    notifusePlan: 'free',
    prospectionPlan: 'freemium',
    trialEndsAt: new Date('2026-06-01'),
    metadata: {},
  };
});

function makeReq(body: any) {
  return {
    json: async () => body,
  } as any;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/admin/tenants/[id]/plan', () => {
  it('returns admin denial if requireAdmin denies', async () => {
    adminDenial = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    const { POST } = await import('@/app/api/admin/tenants/[id]/plan/route');
    const res = await POST(makeReq({ app: 'notifuse', plan: 'pro' }), ctx('t-1'));
    expect(res.status).toBe(403);
  });

  it('returns 400 on invalid app', async () => {
    const { POST } = await import('@/app/api/admin/tenants/[id]/plan/route');
    const res = await POST(makeReq({ app: 'twenty', plan: 'pro' }), ctx('t-1'));
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid notifuse plan', async () => {
    const { POST } = await import('@/app/api/admin/tenants/[id]/plan/route');
    const res = await POST(makeReq({ app: 'notifuse', plan: 'unicorn' }), ctx('t-1'));
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid prospection plan', async () => {
    const { POST } = await import('@/app/api/admin/tenants/[id]/plan/route');
    const res = await POST(makeReq({ app: 'prospection', plan: 'unicorn' }), ctx('t-1'));
    expect(res.status).toBe(400);
  });

  it('returns 404 if tenant not found', async () => {
    tenantRow = null;
    const { POST } = await import('@/app/api/admin/tenants/[id]/plan/route');
    const res = await POST(makeReq({ app: 'notifuse', plan: 'pro' }), ctx('missing'));
    expect(res.status).toBe(404);
  });

  it('returns 409 if Notifuse workspace not provisioned', async () => {
    tenantRow.notifuseWorkspaceSlug = null;
    const { POST } = await import('@/app/api/admin/tenants/[id]/plan/route');
    const res = await POST(makeReq({ app: 'notifuse', plan: 'pro' }), ctx('t-1'));
    expect(res.status).toBe(409);
  });

  it('pushes plan to Notifuse + writes DB on notifuse update', async () => {
    const { POST } = await import('@/app/api/admin/tenants/[id]/plan/route');
    const res = await POST(makeReq({ app: 'notifuse', plan: 'pro' }), ctx('t-1'));
    expect(res.status).toBe(200);
    expect(updatePlanMock).toHaveBeenCalledWith({ tenantId: 'ws-1', plan: 'pro' });
    expect(updateTenantMock).toHaveBeenCalled();
    const body = await res.json();
    expect(body.app).toBe('notifuse');
    expect(body.plan).toBe('pro');
  });

  it('accepts internal/lifetime plans for notifuse', async () => {
    const { POST } = await import('@/app/api/admin/tenants/[id]/plan/route');
    const res = await POST(
      makeReq({ app: 'notifuse', plan: 'lifetime_site_vitrine' }),
      ctx('t-1'),
    );
    expect(res.status).toBe(200);
    expect(updatePlanMock).toHaveBeenCalledWith({
      tenantId: 'ws-1',
      plan: 'lifetime_site_vitrine',
    });
  });

  it('writes DB only on prospection update + returns warning', async () => {
    const { POST } = await import('@/app/api/admin/tenants/[id]/plan/route');
    const res = await POST(makeReq({ app: 'prospection', plan: 'pro' }), ctx('t-1'));
    expect(res.status).toBe(200);
    expect(updatePlanMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.app).toBe('prospection');
    expect(body.plan).toBe('pro');
    expect(body.warning).toContain('Prospection');
  });

  it('updates trialEndsAt to null when explicit null', async () => {
    const { POST } = await import('@/app/api/admin/tenants/[id]/plan/route');
    const res = await POST(
      makeReq({ app: 'prospection', plan: 'freemium', trialEndsAt: null }),
      ctx('t-1'),
    );
    expect(res.status).toBe(200);
    const callArg = updateTenantMock.mock.calls[0][0];
    expect(callArg.data.trialEndsAt).toBeNull();
  });

  it('returns 400 if trialEndsAt is invalid date', async () => {
    const { POST } = await import('@/app/api/admin/tenants/[id]/plan/route');
    const res = await POST(
      makeReq({ app: 'notifuse', plan: 'pro', trialEndsAt: 'banane' }),
      ctx('t-1'),
    );
    expect(res.status).toBe(400);
  });
});
