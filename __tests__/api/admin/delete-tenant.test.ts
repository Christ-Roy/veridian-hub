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

const tenantUpdateManyMock = vi.fn(async ({ where, data }: any) => {
  const ids: string[] = where.id?.in ?? [];
  let count = 0;
  for (const id of ids) {
    const cur = tenantStore.get(id);
    if (cur) {
      tenantStore.set(id, { ...cur, ...data });
      count += 1;
    }
  }
  return { count };
});

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
      updateMany: tenantUpdateManyMock,
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
  tenantUpdateManyMock.mockClear();
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
    // Garde la trace par tenant pour audit
    expect(JSON.stringify(body.actions)).toContain('t1');
    // Warning notifuse préservé
    expect(JSON.stringify(body.actions)).toContain('Notifuse workspace ws');
  });

  it('N+1 regression guard: 3 tenants → 1 updateMany, not 3 updates', async () => {
    userStore.set('multi@test', { id: 'auth-m', supabaseUserId: 'uuid-m' });
    tenantStore.set('tm1', { id: 'tm1', userId: 'uuid-m', notifuseWorkspaceSlug: 'ws1' });
    tenantStore.set('tm2', { id: 'tm2', userId: 'uuid-m', notifuseWorkspaceSlug: null });
    tenantStore.set('tm3', { id: 'tm3', userId: 'uuid-m', notifuseWorkspaceSlug: 'ws3' });

    const { DELETE } = await import('@/app/api/admin/delete-tenant/route');
    const res = await DELETE(makeReq({ email: 'multi@test', confirm: true }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    // Critique: une seule query DB peu importe le nombre de tenants
    expect(tenantUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(tenantUpdateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ['tm1', 'tm2', 'tm3'] } },
      data: expect.objectContaining({ status: 'deleted', deletedAt: expect.any(Date) }),
    });
    // Tous les tenants effectivement soft-deletés
    expect(tenantStore.get('tm1').status).toBe('deleted');
    expect(tenantStore.get('tm2').status).toBe('deleted');
    expect(tenantStore.get('tm3').status).toBe('deleted');
    // Warnings notifuse pour les 2 qui ont un slug
    const actionsStr = JSON.stringify(body.actions);
    expect(actionsStr).toContain('Notifuse workspace ws1');
    expect(actionsStr).toContain('Notifuse workspace ws3');
  });

  it('handles 0 tenant gracefully (no updateMany call)', async () => {
    userStore.set('empty@test', { id: 'auth-e', supabaseUserId: 'uuid-e' });
    const { DELETE } = await import('@/app/api/admin/delete-tenant/route');
    const res = await DELETE(makeReq({ email: 'empty@test', confirm: true }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(tenantUpdateManyMock).not.toHaveBeenCalled();
    expect(JSON.stringify(body.actions)).toContain('No tenant row found');
  });
});
