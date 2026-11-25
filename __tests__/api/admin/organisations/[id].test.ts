// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), regler: vi.fn(), doc: vi.fn(), emissions: vi.fn() }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: (...a: unknown[]) => m.admin(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: { organisationEmission: { findMany: () => m.emissions() } } }));
vi.mock('@/lib/organisations/reglage', async (o) => ({ ...(await o<object>()), reglerOrganisation: (...a: unknown[]) => m.regler(...a) }));
vi.mock('@/lib/organisations/document', async (o) => ({ ...(await o<object>()), documentOrg: () => m.doc() }));

import { GET, PUT } from '@/app/api/admin/organisations/[id]/route';

const T = '11111111-1111-4111-8111-111111111111';
const ctx = (id = T) => ({ params: Promise.resolve({ id }) });
const put = (corps: unknown, id = T) => PUT(new NextRequest('https://h/x', { method: 'PUT', body: JSON.stringify(corps) }), ctx(id));
const get = () => GET(new NextRequest('https://h/x'), ctx());
beforeEach(() => {
  vi.clearAllMocks();
  m.admin.mockResolvedValue(null);
  m.regler.mockResolvedValue({ emissions: [{ app: 'academy', etat: 'applique' }] });
  m.doc.mockResolvedValue({ version: 5 });
  m.emissions.mockResolvedValue([{ app: 'academy', version: BigInt(5), etat: 'applique', detail: null, le: new Date(0) }]);
});

describe('GET', () => {
  it('le document et ce que chaque app sert ; une version en retard n\'est pas à jour', async () => {
    expect((await (await get()).json()).emissions[0].a_jour).toBe(true);
    m.doc.mockResolvedValue({ version: 6 });
    expect((await (await get()).json()).emissions[0].a_jour).toBe(false);
    m.doc.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });
});
describe('PUT', () => {
  it('200 tout appliqué, 207 une app en retard, 404 tenant, 400 corps ou identifiant', async () => {
    expect((await put({ type: 'organisation' })).status).toBe(200);
    expect(m.regler.mock.calls[0][1]).toMatchObject({ tenantId: T, reglage: { type: 'organisation' } });
    m.regler.mockResolvedValue({ emissions: [{ app: 'academy', etat: 'non_relu' }] });
    expect((await put({})).status).toBe(207);
    m.regler.mockResolvedValue({ refus: 'tenant_introuvable' });
    expect((await put({})).status).toBe(404);
    expect((await put({ couleur_primaire: 'x' })).status).toBe(400);
    expect((await put({}, 'x')).status).toBe(400);
  });
  it('aucune app cochée : 200, rien n\'est en retard', async () => {
    m.regler.mockResolvedValue({ emissions: [] });
    expect((await put({ nom_affiche: 'A' })).status).toBe(200);
  });
  it('admin seulement', async () => {
    m.admin.mockResolvedValue(NextResponse.json({}, { status: 401 }));
    expect([(await put({})).status, (await get()).status]).toEqual([401, 401]);
    expect(m.regler).not.toHaveBeenCalled();
  });
});
