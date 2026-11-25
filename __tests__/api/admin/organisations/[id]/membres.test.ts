// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), importer: vi.fn(), lister: vi.fn(), annuler: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/tenants/preinscription', async (orig) => ({ ...(await orig<object>()), listerPreinscriptions: (...a: unknown[]) => m.lister(...a), annulerPreinscriptions: (...a: unknown[]) => m.annuler(...a) }));
vi.mock('@/lib/admin/audit-log', async (orig) => ({ ...(await orig<object>()), writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: (...a: unknown[]) => m.admin(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/organisations/importer', async (orig) => ({ ...(await orig<typeof import('@/lib/organisations/importer')>()), importerMembres: (...a: unknown[]) => m.importer(...a) }));

import { DELETE, GET, POST } from '@/app/api/admin/organisations/[id]/membres/route';

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
    m.importer.mockResolvedValue({ lignes: [{ email: 'a@x.fr', role: 'member', etat: 'retire' }], organisation: [] });
    const r = await POST(req({ membres: [{ email: 'a@x.fr' }] }), ctx());
    expect(r.status).toBe(207);
  });
  it('pré-inscrite : attendue, pas un échec', async () => {
    m.importer.mockResolvedValue({ lignes: [{ email: 'a@x.fr', role: 'member', etat: 'preinscrit' }], organisation: [] });
    expect((await POST(req({ membres: [{ email: 'a@x.fr' }] }), ctx())).status).toBe(200);
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

describe('pré-inscriptions : GET et DELETE', () => {
  const del = (corps: unknown, id = T) => DELETE(new NextRequest('https://h/x', { method: 'DELETE', body: JSON.stringify(corps) }), ctx(id));
  it('GET rend la liste de CETTE organisation', async () => {
    m.lister.mockResolvedValue([{ email: 'a@x.fr', etat: 'en_attente' }]);
    const r = await GET(new NextRequest('https://h/x'), ctx());
    expect([r.status, await r.json(), m.lister.mock.calls[0][1]]).toEqual([200, { preinscrits: [{ email: 'a@x.fr', etat: 'en_attente' }] }, T]);
  });
  it('DELETE annule une adresse et le note, sans l\'adresse ; rien à annuler : rien de noté', async () => {
    m.annuler.mockResolvedValue(1);
    expect(await (await del({ email: 'a@x.fr' })).json()).toEqual({ annulees: 1 });
    expect(JSON.stringify(m.audit.mock.calls)).not.toContain('a@x.fr');
    m.annuler.mockResolvedValue(0);
    await del({ email: 'a@x.fr' });
    expect(m.audit).toHaveBeenCalledTimes(1);
  });
  it('entrée fausse ou sans droit : rien', async () => {
    expect((await del({ email: 'x' })).status).toBe(400);
    expect((await del({ email: 'a@x.fr', plus: 1 })).status).toBe(400);
    expect((await GET(new NextRequest('https://h/x'), ctx('x'))).status).toBe(400);
    m.admin.mockResolvedValue(new Response('', { status: 403 }));
    expect([(await del({ email: 'a@x.fr' })).status, (await GET(new NextRequest('https://h/x'), ctx())).status]).toEqual([403, 403]);
    expect([m.lister.mock.calls.length, m.annuler.mock.calls.length]).toEqual([0, 0]);
  });
});
