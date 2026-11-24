// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), importer: vi.fn() }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: (...a: unknown[]) => m.admin(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/organisations/importer', async (orig) => ({ ...(await orig<typeof import('@/lib/organisations/importer')>()), importerMembres: (...a: unknown[]) => m.importer(...a) }));

import { POST } from '@/app/api/admin/organisations/[id]/membres/route';

const T = '11111111-1111-4111-8111-111111111111';
const ctx = (id = T) => ({ params: Promise.resolve({ id }) });
const req = (corps: unknown) => new NextRequest('https://h/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corps) });
beforeEach(() => { vi.clearAllMocks(); m.admin.mockResolvedValue(null); m.importer.mockResolvedValue({ lignes: [{ email: 'a@x.fr', role: 'member', etat: 'joint' }], organisation: [{ app: 'academy', etat: 'applique' }] }); });

describe('POST organisations/[id]/membres', () => {
  it('tout joint ou déjà et app à jour : 200, avec le compte par état ; l\'essai à blanc est transmis', async () => {
    const r = await POST(req({ membres: [{ email: 'a@x.fr' }], a_blanc: true }), ctx());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ compte: { joint: 1 }, a_blanc: true });
    expect(m.importer.mock.calls[0][1]).toMatchObject({ aBlanc: true });
    await POST(req({ membres: [{ email: 'a@x.fr' }] }), ctx());
    expect(m.importer.mock.calls[1][1]).toMatchObject({ aBlanc: false });
    expect(m.importer.mock.calls[0][1]).toMatchObject({ tenantId: T, membres: [{ email: 'a@x.fr' }] });
  });
  it('une ligne non jointe : 207', async () => {
    m.importer.mockResolvedValue({ lignes: [{ email: 'a@x.fr', role: 'member', etat: 'compte_absent' }], organisation: [] });
    const r = await POST(req({ membres: [{ email: 'a@x.fr' }] }), ctx());
    expect(r.status).toBe(207);
  });
  it('une app en retard : 207 même si toutes les lignes sont jointes', async () => {
    m.importer.mockResolvedValue({ lignes: [{ email: 'a@x.fr', role: 'member', etat: 'joint' }], organisation: [{ app: 'academy', etat: 'echec' }] });
    expect((await POST(req({ membres: [{ email: 'a@x.fr' }] }), ctx())).status).toBe(207);
  });
  it('refus : 400 pour une entrée invalide, plus de 500 adresses, champ inconnu ; 404 tenant introuvable ; requireAdmin refuse : propagé', async () => {
    expect((await POST(req({ membres: [] }), ctx())).status).toBe(400);
    expect((await POST(req({ membres: Array.from({ length: 501 }, (_, i) => ({ email: `u${i}@x.fr` })) }), ctx())).status).toBe(400);
    expect((await POST(req({ membres: [{ email: 'a@x.fr' }], nope: 1 }), ctx())).status).toBe(400);
    expect((await POST(req({ membres: [{ email: 'a@x.fr' }] }), ctx('x'))).status).toBe(400);
    m.importer.mockResolvedValue({ refus: 'tenant_introuvable' });
    expect((await POST(req({ membres: [{ email: 'a@x.fr' }] }), ctx())).status).toBe(404);
    m.admin.mockResolvedValue(new Response('', { status: 403 }));
    expect((await POST(req({ membres: [{ email: 'a@x.fr' }] }), ctx())).status).toBe(403);
    expect(m.importer).toHaveBeenCalledTimes(1);
  });
});
