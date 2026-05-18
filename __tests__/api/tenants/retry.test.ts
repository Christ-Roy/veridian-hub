/**
 * Test smoke pour POST /api/tenants/retry après removal Twenty (2026-05-18).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/get-user', () => ({
  requireUser: vi.fn(async () => ({
    id: 'u1',
    email: 'a@test',
    supabaseUserId: 'uuid-1',
  })),
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

vi.mock('@/utils/tenants/provision', () => ({
  provisionTenants: vi.fn(async () => ({ success: true })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  tenantRow = null;
});

describe('POST /api/tenants/retry', () => {
  it('returns "All services already provisioned" when notifuse + prospection both set', async () => {
    tenantRow = {
      id: 't1',
      prospectionProvisionedAt: new Date(),
      notifuseWorkspaceSlug: 'ws',
    };
    const { POST } = await import('@/app/api/tenants/retry/route');
    const res = await POST();
    const body = await res.json();
    expect(body.message).toBe('All services already provisioned');
    expect(body).not.toHaveProperty('twenty');
  });

  it('triggers provisionTenants when not fully provisioned', async () => {
    tenantRow = null;
    const { POST } = await import('@/app/api/tenants/retry/route');
    const res = await POST();
    expect(res.status).toBe(200);
  });

  it('calls provisionTenants with new 2-arg signature (no password)', async () => {
    tenantRow = null;
    const provisionMod = await import('@/utils/tenants/provision');
    const { POST } = await import('@/app/api/tenants/retry/route');
    await POST();
    // Nouvelle signature post-2026-05-18 : (email, userId), pas de password
    expect(provisionMod.provisionTenants).toHaveBeenCalledWith('a@test', 'uuid-1');
  });
});
