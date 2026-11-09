/**
 * Relier les tenants Prospection existants à leur tenant Hub : simulation par défaut, et en
 * application rien d'autre que le lien et le jeton de connexion (ni plan remis à zéro, ni crédit).
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const provisionTenant = vi.fn(async () => ({ login_url: 'https://p/api/auth/token?t=neuf', api_key: 'x', tenant_id: 'a@b.c', created: true }));
const tenantUpdate = vi.fn(async () => ({}));

vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: vi.fn(async () => null) }));
vi.mock('@/lib/prospection/client', () => ({ createProspectionClientFromEnv: () => ({ provisionTenant }) }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findMany: vi.fn(async () => [
        { id: '11111111-1111-4111-8111-111111111111', userId: 'u1', name: 'Agence', prospectionPlan: 'enterprise' },
        { id: '22222222-2222-4222-8222-222222222222', userId: 'u2', name: 'Orpheline', prospectionPlan: null },
      ]),
      update: tenantUpdate,
    },
    user: { findMany: vi.fn(async () => [{ supabaseUserId: 'u1', email: 'client@exemple.fr', emailVerified: new Date() }]) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

const req = (corps: unknown) => new NextRequest('https://app.veridian.site/api/admin/prospection/relier', { method: 'POST', body: JSON.stringify(corps) });

beforeEach(() => {
  provisionTenant.mockClear();
  tenantUpdate.mockClear();
});

describe('POST /api/admin/prospection/relier', () => {
  it('simulation par défaut : aucun appel à Prospection, aucune écriture', async () => {
    const { POST } = await import('@/app/api/admin/prospection/relier/route');
    const r = await (await POST(req({}))).json();
    expect(provisionTenant).not.toHaveBeenCalled();
    expect(tenantUpdate).not.toHaveBeenCalled();
    expect(r.resultats.map((x: { issue: string }) => x.issue)).toEqual(['a_relier', 'proprietaire_absent']);
  });

  it('application : hub_tenant_id et plan ACTUEL envoyés, seul le jeton de connexion est recopié', async () => {
    const { POST } = await import('@/app/api/admin/prospection/relier/route');
    const res = await POST(req({ appliquer: true }));
    expect(res.status).toBe(207); // un propriétaire absent
    expect(provisionTenant).toHaveBeenCalledTimes(1);
    expect(provisionTenant.mock.calls[0][0]).toMatchObject({
      hubTenantId: '11111111-1111-4111-8111-111111111111',
      plan: 'enterprise',
      userId: 'u1',
      emailProven: true,
    });
    expect(tenantUpdate).toHaveBeenCalledTimes(1);
    const data = (tenantUpdate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(Object.keys(data).sort()).toEqual(['prospectionLoginToken', 'prospectionLoginTokenCreatedAt', 'prospectionLoginTokenUsed']);
    expect(data.prospectionLoginToken).toBe('neuf');
  });
});
