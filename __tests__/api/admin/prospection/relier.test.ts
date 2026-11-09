/**
 * Relier les tenants Prospection existants à leur tenant Hub : simulation par défaut ; en
 * application, un seul appel link-hub par tenant, jamais le rejeu du provisionnement (il remet le
 * rôle du propriétaire et recrée l'espace `default` chez Prospection), et aucune écriture au Hub.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const linkHub = vi.fn(async () => ({ linked: true }));
const provisionTenant = vi.fn();
const tenantUpdate = vi.fn(async () => ({}));

vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: vi.fn(async () => null) }));
vi.mock('@/lib/prospection/client', () => ({ createProspectionClientFromEnv: () => ({ linkHub, provisionTenant }) }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findMany: vi.fn(async () => [
        { id: '11111111-1111-4111-8111-111111111111', userId: 'u1' },
        { id: '22222222-2222-4222-8222-222222222222', userId: 'u2' },
      ]),
      update: tenantUpdate,
    },
    user: { findMany: vi.fn(async () => [{ supabaseUserId: 'u1' }]) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

const req = (corps: unknown) => new NextRequest('https://app.veridian.site/api/admin/prospection/relier', { method: 'POST', body: JSON.stringify(corps) });

beforeEach(() => {
  linkHub.mockClear();
  provisionTenant.mockClear();
  tenantUpdate.mockClear();
});

describe('POST /api/admin/prospection/relier', () => {
  it('simulation par défaut : aucun appel à Prospection', async () => {
    const { POST } = await import('@/app/api/admin/prospection/relier/route');
    const r = await (await POST(req({}))).json();
    expect(linkHub).not.toHaveBeenCalled();
    expect(r.resultats.map((x: { issue: string }) => x.issue)).toEqual(['a_relier', 'proprietaire_absent']);
  });

  it('application : link-hub seul, jamais le provisionnement, aucune écriture au Hub', async () => {
    const { POST } = await import('@/app/api/admin/prospection/relier/route');
    const res = await POST(req({ appliquer: true }));
    expect(res.status).toBe(207); // un propriétaire absent
    expect(linkHub).toHaveBeenCalledTimes(1);
    expect(linkHub).toHaveBeenCalledWith({ hubUserId: 'u1', hubTenantId: '11111111-1111-4111-8111-111111111111' });
    expect(provisionTenant).not.toHaveBeenCalled();
    expect(tenantUpdate).not.toHaveBeenCalled();
  });

  it('lien refusé par Prospection : compté en échec, avec sa raison', async () => {
    linkHub.mockResolvedValueOnce({ linked: false, raison: 'deja_relie_ailleurs' } as never);
    const { POST } = await import('@/app/api/admin/prospection/relier/route');
    const r = await (await POST(req({ appliquer: true }))).json();
    expect(r.resultats[0].issue).toBe('non_relie: deja_relie_ailleurs');
  });
});
