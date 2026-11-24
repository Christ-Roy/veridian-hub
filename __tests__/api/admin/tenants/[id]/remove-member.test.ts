// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), rejoindre: vi.fn(), retirer: vi.fn(), basculer: vi.fn(), user: vi.fn() }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: (...a: unknown[]) => m.admin(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findFirst: (...a: unknown[]) => m.user(...a) } } }));
vi.mock('@/lib/tenants/membres', async (o) => ({ ...(await o<object>()), rejoindre: (...a: unknown[]) => m.rejoindre(...a), retirer: (...a: unknown[]) => m.retirer(...a), basculerSuspension: (...a: unknown[]) => m.basculer(...a) }));

import { POST } from '@/app/api/admin/tenants/[id]/remove-member/route';
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

describe('POST remove-member', () => {
  it('admin seulement', refusAdmin);
  it('complet : 200 ; une app n\'a pas suivi : 207, jamais un faux vert', async () => {
    expect((await jouer({ email: 'a@b.fr' })).status).toBe(200);
    m.retirer.mockResolvedValue({ deja: false, apps: [{ app: 'crm', etat: 'echec' }], complet: false });
    const r = await jouer({ hub_user_id: U });
    expect([r.status, (await r.json()).apps[0].etat]).toEqual([207, 'echec']);
  });
  it('le propriétaire : 409 cannot_remove_owner (contrat §5.19) ; invalide : 400 ; panne : 500', async () => {
    m.retirer.mockRejectedValue(new RefusMembre('proprietaire'));
    const r = await jouer({ email: 'a@b.fr' });
    expect([r.status, (await r.json()).error]).toEqual([409, 'cannot_remove_owner']);
    expect((await jouer({})).status).toBe(400);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.retirer.mockRejectedValue(new Error('base'));
    expect((await jouer({ email: 'a@b.fr' })).status).toBe(500);
  });
});
