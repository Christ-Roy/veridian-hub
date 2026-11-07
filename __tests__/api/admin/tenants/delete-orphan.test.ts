import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAdmin = vi.fn(async () => null as Response | null);
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
  user: { findUnique: vi.fn() },
  tenantMember: { count: vi.fn() },
  subscription: { count: vi.fn() },
  auditLog: { create: vi.fn(async () => ({})) },
}));
vi.mock('@/lib/prisma', () => ({ prisma: db }));

import { DELETE } from '@/app/api/admin/tenants/[id]/route';

const appel = (body: unknown = { confirm: true }) =>
  DELETE(
    new NextRequest('https://hub.test/api/admin/tenants/t1', {
      method: 'DELETE',
      headers: { 'x-admin-secret': 'x' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 't1' }) },
  );

describe('DELETE /api/admin/tenants/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdmin.mockResolvedValue(null);
    db.tenant.findUnique.mockResolvedValue({ id: 't1', name: 'e2e-1', userId: 'u1', status: 'active' });
    db.user.findUnique.mockResolvedValue(null);
    db.tenantMember.count.mockResolvedValue(0);
    db.subscription.count.mockResolvedValue(0);
  });

  it('refuse un non-admin, sans rien lire ni écrire', async () => {
    requireAdmin.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await appel()).status).toBe(403);
    expect(db.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('exige confirm: true', async () => {
    expect((await appel({})).status).toBe(400);
    expect(db.tenant.update).not.toHaveBeenCalled();
  });

  it.each([
    ['un utilisateur', () => db.user.findUnique.mockResolvedValue({ id: 'x' })],
    ['un membre', () => db.tenantMember.count.mockResolvedValue(1)],
    ['un abonnement', () => db.subscription.count.mockResolvedValue(1)],
  ])('refuse un tenant qui a %s, sans rien écrire', async (_l, poser) => {
    poser();
    expect((await appel()).status).toBe(409);
    expect(db.tenant.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('retire un orphelin en soft-delete et le trace', async () => {
    expect((await appel()).status).toBe(200);
    const data = (db.tenant.update.mock.calls[0] as never as [{ data: { status: string; deletedAt: Date } }])[0].data;
    expect(data.status).toBe('deleted');
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect((db.auditLog.create.mock.calls[0] as never as [{ data: { action: string; targetId: string } }])[0].data).toMatchObject({
      action: 'admin.tenant.delete_orphan',
      targetId: 't1',
    });
  });
});
