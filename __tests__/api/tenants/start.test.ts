/**
 * Test pour POST /api/tenants/start — provisioning on-demand par app
 * (Robert 2026-05-18).
 *
 * Vérifie :
 *   1. 401 si pas de session.
 *   2. 400 si app invalide.
 *   3. Idempotent : retourne already_provisioned=true sans appeler le provisioner si déjà OK.
 *   4. Appelle provisionTenants avec le bon `app` quand cible non provisionnée.
 *   5. Body vide → default app=all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const provisionTenantsMock = vi.fn(async () => ({
  success: true,
  notifuse: { success: true, workspaceId: 'ws-1', autoLoginUrl: 'https://nf/auto' },
  prospection: { success: true, tenantId: 't-prosp', loginUrl: 'https://pr/auto' },
}));

vi.mock('@/utils/tenants/provision', () => ({
  provisionTenants: (...args: any[]) => provisionTenantsMock(...args),
}));

let mockUser: any = {
  id: 'u-1',
  email: 'r@test.io',
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

let tenantRow: any = null;

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(async () => tenantRow),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  tenantRow = null;
  mockUser = {
    id: 'u-1',
    email: 'r@test.io',
    supabaseUserId: 'uuid-1',
  };
});

function makeReq(body: any) {
  return {
    json: async () => body,
  } as any;
}

describe('POST /api/tenants/start', () => {
  it('returns 401 if no session', async () => {
    mockUser = null;
    const { POST } = await import('@/app/api/tenants/start/route');
    const res = await POST(makeReq({}));
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid app value', async () => {
    const { POST } = await import('@/app/api/tenants/start/route');
    const res = await POST(makeReq({ app: 'twenty' }));
    expect(res.status).toBe(400);
  });

  it('is idempotent — returns already_provisioned=true when notifuse already set', async () => {
    tenantRow = {
      id: 't-1',
      notifuseWorkspaceSlug: 'ws-existing',
      prospectionProvisionedAt: null,
    };
    const { POST } = await import('@/app/api/tenants/start/route');
    const res = await POST(makeReq({ app: 'notifuse' }));
    const body = await res.json();
    expect(body.already_provisioned).toBe(true);
    expect(provisionTenantsMock).not.toHaveBeenCalled();
  });

  it('triggers provisionTenants with the requested app', async () => {
    tenantRow = null;
    const { POST } = await import('@/app/api/tenants/start/route');
    const res = await POST(makeReq({ app: 'prospection' }));
    expect(res.status).toBe(200);
    expect(provisionTenantsMock).toHaveBeenCalledWith(
      'r@test.io',
      'uuid-1',
      { app: 'prospection' },
    );
  });

  it('defaults to app=all when body is empty', async () => {
    const { POST } = await import('@/app/api/tenants/start/route');
    const res = await POST({ json: async () => { throw new Error('no body'); } } as any);
    expect(res.status).toBe(200);
    expect(provisionTenantsMock).toHaveBeenCalledWith(
      'r@test.io',
      'uuid-1',
      { app: 'all' },
    );
  });

  it('does NOT short-circuit when notifuse done but prospection asked', async () => {
    tenantRow = {
      id: 't-1',
      notifuseWorkspaceSlug: 'ws-existing',
      prospectionProvisionedAt: null,
    };
    const { POST } = await import('@/app/api/tenants/start/route');
    const res = await POST(makeReq({ app: 'prospection' }));
    expect(res.status).toBe(200);
    expect(provisionTenantsMock).toHaveBeenCalled();
  });
});
