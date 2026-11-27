// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), rejoindre: vi.fn(), retirer: vi.fn(), basculer: vi.fn(), user: vi.fn() }));
vi.mock('@/lib/admin/authenticate', () => ({ authenticateAdmin: async (...a: unknown[]) => { const r = (await ((...a: unknown[]) => m.admin(...a))(...a)) as Response | null; return r ? { ok: false, response: r } : { ok: true, sessionEmail: null, hubUserId: null }; } }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findFirst: (...a: unknown[]) => m.user(...a) } } }));
vi.mock('@/lib/tenants/membres', async (o) => ({ ...(await o<object>()), rejoindre: (...a: unknown[]) => m.rejoindre(...a), retirer: (...a: unknown[]) => m.retirer(...a), basculerSuspension: (...a: unknown[]) => m.basculer(...a) }));

import { POST } from '@/app/api/admin/tenants/[id]/members/route';
const pousser = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown[]> => [{ app: 'crm', etat: 'applique' }]));
vi.mock('@/lib/tenants/roles', () => ({ pousserRole: pousser }));
const suivre = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []));
vi.mock('@/lib/organisations/emission', () => ({ suivreOrganisation: suivre }));

const presence = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []));
vi.mock('@/lib/apps/presence', async (o) => ({ ...(await o<object>()), presenceDe: presence }));

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

describe('POST members', () => {
  it('admin seulement', refusAdmin);
  it('« créé » ne suffit pas : ce que chaque app voit est rendu, et un manque attendu fait 207', async () => {
    presence.mockResolvedValueOnce([{ app: 'notifuse', etat: 'absente' }]);
    const r = await jouer({ email: 'a@b.fr' });
    expect([r.status, (await r.json()).presence]).toEqual([207, [{ app: 'notifuse', etat: 'absente' }]]);
    presence.mockResolvedValueOnce([{ app: 'notifuse', etat: 'non_cochee' }, { app: 'crm', etat: 'sans_espace' }, { app: 'prospection', etat: 'presente' }]);
    expect((await jouer({ email: 'a@b.fr' })).status, 'rien d\'attendu ne manque').toBe(200);
  });
  it('pose un membre en opérateur, member par défaut', async () => {
    expect((await jouer({ email: 'a@b.fr' })).status).toBe(200);
    expect(m.rejoindre.mock.calls[0][1]).toMatchObject({ tenantId: T, hubUserId: U, role: 'member', origine: 'operateur' });
    await jouer({ hub_user_id: U, role: 'owner' });
    expect(m.rejoindre.mock.calls[1][1]).toMatchObject({ role: 'owner' });
  });
  it('l\'organisation réglée au Hub suit, après l\'ajout ; non réglée, elle n\'apparaît pas', async () => {
    expect(await (await jouer({ email: 'a@b.fr' })).json()).not.toHaveProperty('organisation');
    suivre.mockResolvedValueOnce([{ app: 'academy', etat: 'applique' }]);
    expect((await (await jouer({ email: 'a@b.fr' })).json()).organisation).toEqual([{ app: 'academy', etat: 'applique' }]);
    expect(suivre.mock.calls.at(-1)?.[1]).toBe(T);
  });
  it('un refus n\'émet rien', async () => {
    m.rejoindre.mockRejectedValue(new RefusMembre('adresse_non_prouvee'));
    await jouer({ email: 'a@b.fr' });
    expect(suivre).not.toHaveBeenCalled();
  });
  it('corps ou tenant invalide : 400 ; compte absent du Hub : 404 ; refus métier lisible', async () => {
    expect((await jouer({})).status).toBe(400);
    expect((await jouer({ email: 'a@b.fr', role: 'dieu' })).status).toBe(400);
    expect((await jouer({ email: 'a@b.fr' }, 'x')).status).toBe(400);
    m.user.mockResolvedValue(null);
    expect((await jouer({ email: 'a@b.fr' })).status).toBe(404);
    m.rejoindre.mockRejectedValue(new RefusMembre('adresse_non_prouvee'));
    const r = await jouer({ hub_user_id: U });
    expect([r.status, (await r.json()).error]).toEqual([409, 'adresse_non_prouvee']);
  });
});

describe('POST members, le rôle part aussitôt', () => {
  it('poussé pour ce compte et cette organisation ; une app qui n\'a pas suivi : 207', async () => {
    const r = await jouer({ hub_user_id: U, role: 'admin' });
    expect([r.status, (await r.json()).apps]).toEqual([200, [{ app: 'crm', etat: 'applique' }]]);
    expect(pousser.mock.calls.at(-1)![1]).toEqual({ tenantId: T, hubUserId: U });
    for (const etat of ['echec', 'refuse']) {
      pousser.mockResolvedValueOnce([{ app: 'crm', etat }]);
      expect((await jouer({ hub_user_id: U })).status).toBe(207);
    }
    pousser.mockResolvedValueOnce([{ app: 'crm', etat: 'ferme' }]);
    expect((await jouer({ hub_user_id: U })).status, 'fermé n\'est pas une panne').toBe(200);
  });
});
