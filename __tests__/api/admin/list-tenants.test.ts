/**
 * Test smoke pour GET /api/admin/list-tenants après removal Twenty (2026-05-18).
 *
 * Vérifie que la route :
 *   1. Refuse les non-admins (403).
 *   2. Liste les tenants sans le bloc `twenty` (qui n'existe plus).
 *   3. Garde `notifuse` et `prospection` dans la response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAdminMock = vi.fn(async () => null);
vi.mock('@/lib/admin/require-admin', () => ({
  requireAdmin: (...args: any[]) => requireAdminMock(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findMany: vi.fn(async () => [
        {
          id: 't1',
          userId: 'u-uuid-1',
          name: 'Test Tenant',
          status: 'active',
          slug: 'test',
          prospectionPlan: 'freemium',
          prospectionProvisionedAt: new Date(),
          notifuseWorkspaceSlug: 'test-ws',
          metadata: {},
          trialEndsAt: new Date(),
          createdAt: new Date(),
        },
      ]),
    },
    user: {
      findMany: vi.fn(async () => [
        { supabaseUserId: 'u-uuid-1', email: 'a@test', createdAt: new Date() },
      ]),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/admin/list-tenants', () => {
  it('returns tenants with notifuse + prospection blocks (no twenty)', async () => {
    const { GET } = await import('@/app/api/admin/list-tenants/route');
    const res = await GET({} as any);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.tenants[0].services).toHaveProperty('notifuse');
    expect(body.tenants[0].services).toHaveProperty('prospection');
    expect(body.tenants[0].services).not.toHaveProperty('twenty');
  });

  it('refuses non-admin via requireAdmin denial', async () => {
    requireAdminMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) as any,
    );
    const { GET } = await import('@/app/api/admin/list-tenants/route');
    const res = await GET({} as any);
    expect(res.status).toBe(403);
  });
});
