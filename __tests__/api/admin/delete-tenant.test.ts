/**
 * Test smoke pour DELETE /api/admin/delete-tenant après removal Twenty (2026-05-18).
 *
 * Vérifie que la route :
 *   1. Refuse les non-admins (denial).
 *   2. Refuse sans confirm: true (400).
 *   3. Soft-delete les tenants + supprime user Auth.js.
 *   4. Ne mentionne plus Twenty dans les warnings.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAdminMock = vi.fn(async () => null);
vi.mock('@/lib/admin/require-admin', () => ({
  requireAdmin: (...args: any[]) => requireAdminMock(...args),
}));

const userStore = new Map<string, any>();
const tenantStore = new Map<string, any>();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: any) => userStore.get(where.email) ?? null),
      delete: vi.fn(async ({ where }: any) => {
        for (const [email, u] of userStore) {
          if (u.id === where.id) {
            userStore.delete(email);
            return u;
          }
        }
        return null;
      }),
    },
    tenant: {
      findMany: vi.fn(async ({ where }: any) => {
        return Array.from(tenantStore.values()).filter((t) => t.userId === where.userId);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const cur = tenantStore.get(where.id);
        const merged = { ...cur, ...data };
        tenantStore.set(where.id, merged);
        return merged;
      }),
    },
    subscription: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    profile: {
      delete: vi.fn(async () => { throw new Error('not found'); }),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  userStore.clear();
  tenantStore.clear();
  requireAdminMock.mockResolvedValue(null);
});

function makeReq(body: any) {
  return { json: async () => body } as any;
}

describe('DELETE /api/admin/delete-tenant', () => {
  it('refuses non-admin', async () => {
    requireAdminMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) as any,
    );
    const { DELETE } = await import('@/app/api/admin/delete-tenant/route');
    const res = await DELETE(makeReq({ email: 'a@test', confirm: true }));
    expect(res.status).toBe(403);
  });

  it('requires confirm: true', async () => {
    const { DELETE } = await import('@/app/api/admin/delete-tenant/route');
    const res = await DELETE(makeReq({ email: 'a@test' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 if user not found', async () => {
    const { DELETE } = await import('@/app/api/admin/delete-tenant/route');
    const res = await DELETE(makeReq({ email: 'missing@test', confirm: true }));
    expect(res.status).toBe(404);
  });

  it('soft-deletes tenant + user, no twenty warning', async () => {
    userStore.set('a@test', { id: 'auth-1', supabaseUserId: 'uuid-1' });
    tenantStore.set('t1', {
      id: 't1',
      userId: 'uuid-1',
      notifuseWorkspaceSlug: 'ws',
    });
    const { DELETE } = await import('@/app/api/admin/delete-tenant/route');
    const res = await DELETE(makeReq({ email: 'a@test', confirm: true }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body.actions).toLowerCase()).not.toContain('twenty');
  });
});
