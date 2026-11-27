// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), rejoindre: vi.fn(), retirer: vi.fn(), basculer: vi.fn(), user: vi.fn() }));
vi.mock('@/lib/admin/authenticate', () => ({ authenticateAdmin: async (...a: unknown[]) => { const r = (await ((...a: unknown[]) => m.admin(...a))(...a)) as Response | null; return r ? { ok: false, response: r } : { ok: true, sessionEmail: null, hubUserId: null }; } }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findFirst: (...a: unknown[]) => m.user(...a) } } }));
vi.mock('@/lib/tenants/membres', async (o) => ({ ...(await o<object>()), rejoindre: (...a: unknown[]) => m.rejoindre(...a), retirer: (...a: unknown[]) => m.retirer(...a), basculerSuspension: (...a: unknown[]) => m.basculer(...a) }));

import { POST } from '@/app/api/admin/tenants/[id]/suspension/route';
import { RefusMembre } from '@/lib/tenants/membres';

const T = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const jouer = (corps: unknown, id = T) => POST(new NextRequest('https://app.veridian.site/x', { method: 'POST', body: JSON.stringify(corps) }), { params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.clearAllMocks();
  m.admin.mockResolvedValue(null);
  m.user.mockResolvedValue({ supabaseUserId: U });
  m.rejoindre.mockResolvedValue({ cree: true, role: 'member' });
  m.retirer.mockResolvedValue({ deja: false, apps: [], complet: true });
  m.basculer.mockResolvedValue({ deja: false, apps: [], complet: true });
});
const refusAdmin = async () => {
  m.admin.mockResolvedValue(NextResponse.json({}, { status: 401 }));
  expect((await jouer({ email: 'a@b.fr', suspendre: true })).status).toBe(401);
  expect([m.rejoindre, m.retirer, m.basculer].flatMap((f) => f.mock.calls)).toEqual([]);
};

describe('POST suspension', () => {
  it('admin seulement', refusAdmin);
  it('suspend et reprend ; une app sans route : 207', async () => {
    expect((await jouer({ suspendre: true, motif: 'impayé' })).status).toBe(200);
    expect(m.basculer.mock.calls[0][1]).toMatchObject({ tenantId: T, suspendre: true, motif: 'impayé' });
    m.basculer.mockResolvedValue({ deja: false, apps: [], complet: false });
    expect((await jouer({ suspendre: false })).status).toBe(207);
  });
  it('sans booléen explicite : 400, rien n\'est suspendu ; tenant inconnu : 404', async () => {
    expect((await jouer({ suspendre: 'oui' })).status).toBe(400);
    expect(m.basculer).not.toHaveBeenCalled();
    m.basculer.mockRejectedValue(new RefusMembre('tenant_introuvable'));
    expect((await jouer({ suspendre: true })).status).toBe(404);
  });
});
