// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ user: vi.fn(), ligne: vi.fn(), emprunt: vi.fn(), recent: vi.fn(), demander: vi.fn(), confirmer: vi.fn(), detacher: vi.fn(), lister: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: (...a: unknown[]) => m.ligne(...a) } } }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user() }));
vi.mock('@/lib/auth/recent-auth', () => ({ PREUVE_COMPTE_S: 1, denyIfImpersonated: () => m.emprunt(), denyUnlessRecentAuth: () => m.recent() }));
vi.mock('@/lib/adresses', () => ({ demanderCode: (...a: unknown[]) => m.demander(...a), confirmerCode: (...a: unknown[]) => m.confirmer(...a), detacher: (...a: unknown[]) => m.detacher(...a), adressesProuvees: (...a: unknown[]) => m.lister(...a) }));

import { GET, POST } from '@/app/api/account/adresses/route';

const poster = async (corps: unknown) => { const r = await POST(new NextRequest('https://h/x', { method: 'POST', body: typeof corps === 'string' ? corps : JSON.stringify(corps) })); return [r.status, await r.json().catch(() => null)]; };
beforeEach(() => {
  vi.clearAllMocks();
  m.user.mockResolvedValue({ id: 'u' });
  m.ligne.mockResolvedValue({ id: 'u', email: 'Jean@gmail.com', emailVerified: new Date() });
  m.emprunt.mockResolvedValue(null);
  m.recent.mockResolvedValue(null);
  m.demander.mockResolvedValue('demande');
  m.confirmer.mockResolvedValue('ajoutee');
  m.detacher.mockResolvedValue(true);
  m.lister.mockResolvedValue(['jean@gmail.com', 'pro@client.fr']);
});
const rien = () => expect([m.demander.mock.calls.length, m.confirmer.mock.calls.length, m.detacher.mock.calls.length]).toEqual([0, 0, 0]);

describe('GET adresses', () => {
  it('les siennes, sans la principale dans les secondaires ; sans session : rien', async () => {
    expect(await (await GET()).json()).toEqual({ principale: 'Jean@gmail.com', principale_prouvee: true, secondaires: ['pro@client.fr'] });
    m.user.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});
describe('POST adresses', () => {
  it('les trois gestes, pour la personne connectée, adresse normalisée', async () => {
    expect(await poster({ geste: 'demander', email: ' Pro@Client.FR ' })).toEqual([200, { ok: true }]);
    expect(m.demander.mock.calls[0].slice(1)).toEqual([expect.objectContaining({ id: 'u' }), 'pro@client.fr']);
    expect(await poster({ geste: 'confirmer', email: 'pro@client.fr', code: '123456' })).toEqual([200, { ok: true }]);
    expect(await poster({ geste: 'detacher', email: 'pro@client.fr' })).toEqual([200, { ok: true }]);
  });
  it('adresse principale non prouvée : aucun droit, pas même celui d\'en ajouter', async () => {
    m.ligne.mockResolvedValue({ id: 'u', email: 'j@x.fr', emailVerified: null });
    expect(await poster({ geste: 'demander', email: 'a@x.fr' })).toEqual([403, { error: 'email_not_verified' }]);
    rien();
  });
  it('sans session, session d\'emprunt, preuve ancienne : rien', async () => {
    m.user.mockResolvedValue(null);
    expect((await poster({ geste: 'demander', email: 'a@x.fr' }))[0]).toBe(401);
    m.user.mockResolvedValue({ id: 'u' });
    m.emprunt.mockResolvedValue(new Response('', { status: 403 }));
    expect((await poster({ geste: 'demander', email: 'a@x.fr' }))[0]).toBe(403);
    m.emprunt.mockResolvedValue(null);
    m.recent.mockResolvedValue(new Response('', { status: 401 }));
    expect((await poster({ geste: 'confirmer', email: 'a@x.fr', code: '123456' }))[0]).toBe(401);
    rien();
  });
  it('corps faux, champ de plus, code mal formé, geste inconnu : 400, rien', async () => {
    for (const c of ['{', {}, { geste: 'demander', email: 'x' }, { geste: 'demander', email: 'a@x.fr', userId: 'v' }, { geste: 'confirmer', email: 'a@x.fr', code: '12345' }, { geste: 'promouvoir', email: 'a@x.fr' }]) expect((await poster(c))[0], JSON.stringify(c)).toBe(400);
    rien();
  });
  it('refus traduits : débit, code faux, prise, inconnue', async () => {
    m.demander.mockResolvedValue('trop');
    expect(await poster({ geste: 'demander', email: 'a@x.fr' })).toEqual([429, { error: 'rate_limited' }]);
    m.confirmer.mockResolvedValue('code_invalide');
    expect(await poster({ geste: 'confirmer', email: 'a@x.fr', code: '123456' })).toEqual([400, { error: 'code_invalide' }]);
    m.confirmer.mockResolvedValue('prise');
    expect(await poster({ geste: 'confirmer', email: 'a@x.fr', code: '123456' })).toEqual([409, { error: 'prise' }]);
    m.detacher.mockResolvedValue(false);
    expect((await poster({ geste: 'detacher', email: 'a@x.fr' }))[0]).toBe(404);
  });
});
