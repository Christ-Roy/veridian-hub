/** Ouvrir l'abonnement par tenant : fermé par défaut, plafond de capacité, audit ; fermer passe toujours. */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ tenants: new Map<string, { id: string; deletedAt: null; metadata: Record<string, unknown> }>(), audit: vi.fn() }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: vi.fn(async () => null) }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => m.tenants.get(where.id) ?? null,
      findMany: async () => [...m.tenants.values()].filter((t) => (t.metadata.ia_atelier as { ouvert?: boolean } | undefined)?.ouvert === true),
      update: async ({ where, data }: { where: { id: string }; data: { metadata: Record<string, unknown> } }) => Object.assign(m.tenants.get(where.id)!, data),
    },
  },
}));

import { POST } from '@/app/api/admin/ia/atelier/route';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const req = (corps: unknown) => new NextRequest('https://app.veridian.site/api/admin/ia/atelier', { method: 'POST', body: JSON.stringify(corps) });

beforeEach(() => {
  m.tenants.clear();
  m.tenants.set(A, { id: A, deletedAt: null, metadata: { crm: { workspace_id: 'w' } } });
  m.tenants.set(B, { id: B, deletedAt: null, metadata: {} });
  m.audit.mockClear();
  delete process.env.ATELIER_CAPACITE;
});

describe('POST /api/admin/ia/atelier', () => {
  it('ouvre un tenant, garde ses autres métadonnées, journalise', async () => {
    expect((await POST(req({ tenant_id: A, ouvert: true }))).status).toBe(200);
    expect(m.tenants.get(A)!.metadata).toMatchObject({ crm: { workspace_id: 'w' }, ia_atelier: { ouvert: true } });
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'admin.ia.atelier', targetId: A }));
  });

  it('capacité 1 (défaut) : un second tenant est refusé en 409 ; rouvrir le premier passe', async () => {
    await POST(req({ tenant_id: A, ouvert: true }));
    const r = await POST(req({ tenant_id: B, ouvert: true }));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('capacite_atteinte');
    expect((m.tenants.get(B)!.metadata.ia_atelier as unknown)).toBeUndefined();
    expect((await POST(req({ tenant_id: A, ouvert: true }))).status).toBe(200);
  });

  it('fermer passe toujours, et libère la place', async () => {
    await POST(req({ tenant_id: A, ouvert: true }));
    expect((await POST(req({ tenant_id: A, ouvert: false }))).status).toBe(200);
    expect((await POST(req({ tenant_id: B, ouvert: true }))).status).toBe(200);
  });

  it('tenant inconnu : 404 ; corps invalide : 400', async () => {
    expect((await POST(req({ tenant_id: '33333333-3333-4333-8333-333333333333', ouvert: true }))).status).toBe(404);
    expect((await POST(req({ tenant_id: 'x', ouvert: true }))).status).toBe(400);
  });
});
