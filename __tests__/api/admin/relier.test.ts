/**
 * Relier les espaces existants d'une app à leur tenant Hub : simulation par défaut ; en application,
 * un appel link-hub par tenant (lien seul), jamais le provisionnement, aucune écriture au Hub.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const linkHub = vi.fn(async () => ({ linked: true, raison: 'relie' }));
const provisionTenant = vi.fn();
const lierAuHub = vi.fn(async () => ({ linked: true, raison: 'deja_relie' }));
const tenantUpdate = vi.fn();

vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: vi.fn(async () => null) }));
vi.mock('@/lib/prospection/client', () => ({ createProspectionClientFromEnv: () => ({ linkHub, provisionTenant }) }));
vi.mock('@/lib/apps/lier-hub', () => ({ lierAuHub }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findMany: vi.fn(async () => [
        { id: '11111111-1111-4111-8111-111111111111', userId: 'u1', metadata: { analytics: { site: 1 } } },
        { id: '22222222-2222-4222-8222-222222222222', userId: 'u2', metadata: {} },
      ]),
      update: tenantUpdate,
    },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

const req = (corps: unknown) => new NextRequest('https://app.veridian.site/api/admin/relier', { method: 'POST', body: JSON.stringify(corps) });

beforeEach(() => {
  [linkHub, provisionTenant, lierAuHub, tenantUpdate].forEach((m) => m.mockClear());
});

describe('POST /api/admin/relier', () => {
  it('simulation par défaut : aucun appel aux apps', async () => {
    const { POST } = await import('@/app/api/admin/relier/route');
    const r = await (await POST(req({ app: 'prospection' }))).json();
    expect(linkHub).not.toHaveBeenCalled();
    expect(r.total).toBe(2);
  });

  it('prospection : link-hub seul, jamais le provisionnement, aucune écriture au Hub', async () => {
    const { POST } = await import('@/app/api/admin/relier/route');
    const r = await (await POST(req({ app: 'prospection', appliquer: true }))).json();
    expect(linkHub).toHaveBeenCalledTimes(2);
    expect(linkHub).toHaveBeenCalledWith({ hubUserId: 'u1', hubTenantId: '11111111-1111-4111-8111-111111111111' });
    expect(provisionTenant).not.toHaveBeenCalled();
    expect(tenantUpdate).not.toHaveBeenCalled();
    expect(r.echecs).toBe(0);
  });

  it('analytics : seulement les tenants qui ont Analytics', async () => {
    const { POST } = await import('@/app/api/admin/relier/route');
    const r = await (await POST(req({ app: 'analytics', appliquer: true }))).json();
    expect(lierAuHub).toHaveBeenCalledTimes(1);
    expect(lierAuHub).toHaveBeenCalledWith('analytics', { hubUserId: 'u1', hubTenantId: '11111111-1111-4111-8111-111111111111' });
    expect(r.resultats).toEqual([{ tenant_id: '11111111-1111-4111-8111-111111111111', issue: 'deja_relie' }]);
  });

  it('lien refusé par l\'app : compté en échec, raison gardée', async () => {
    linkHub.mockResolvedValueOnce({ linked: false, raison: 'lien_different' });
    const { POST } = await import('@/app/api/admin/relier/route');
    const res = await POST(req({ app: 'prospection', appliquer: true }));
    expect(res.status).toBe(207);
    expect((await res.json()).resultats[0].issue).toBe('non_relie: lien_different');
  });
});
