// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ appel: vi.fn(), doc: vi.fn(), lu: vi.fn(), deborde: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/delegation/jeton', () => ({ verifierAppel: (...a: unknown[]) => m.appel(...a), deborde: () => m.deborde() }));
vi.mock('@/lib/organisations/document', () => ({ documentOrg: () => m.doc() }));
vi.mock('@/lib/organisations/activite', async (o) => ({ ...(await o<object>()), activite: (...a: unknown[]) => m.lu(...a) }));

import { POST } from '@/app/api/organisations/activite/route';

const T = '11111111-1111-4111-8111-111111111111';
const CORPS = { hub_tenant_id: T, hub_user_id: '22222222-2222-4222-8222-222222222222', prefixe: 'twenty.create_', depuis: '2026-11-25T00:00:00Z' };
const lire = (corps: unknown = CORPS) => POST(new NextRequest('https://h/x', { method: 'POST', body: typeof corps === 'string' ? corps : JSON.stringify(corps) }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ACTIVITE_ORGANISATIONS', T);
  m.appel.mockResolvedValue({ app: 'academy' });
  m.deborde.mockReturnValue(false);
  m.doc.mockResolvedValue({ modules: ['academy'] });
  m.lu.mockResolvedValue({ fait: true, premier: 'a', dernier: 'b', nombre: 2 });
});

describe('POST activite', () => {
  it('Academy seule, organisation ouverte et cochée', async () => {
    const r = await lire();
    expect([r.status, await r.json()]).toEqual([200, { fait: true, premier: 'a', dernier: 'b', nombre: 2 }]);
    expect(m.appel.mock.calls[0][4]).toEqual(['academy']);
  });
  it.each([
    ['fermée (défaut)', () => vi.stubEnv('ACTIVITE_ORGANISATIONS', '')],
    ['« tous » n\'ouvre rien', () => vi.stubEnv('ACTIVITE_ORGANISATIONS', 'tous')],
    ['non cochée', () => m.doc.mockResolvedValue({ modules: ['prospection'] })],
    ['inconnue', () => m.doc.mockResolvedValue(null)],
  ])('%s : 404, la même réponse, rien n\'est lu', async (_n, f) => {
    f();
    const r = await lire();
    expect([r.status, await r.json()]).toEqual([404, { error: 'organisation_introuvable' }]);
    expect(m.lu).not.toHaveBeenCalled();
  });
  it('signature refusée, débit, corps faux : rien n\'est lu', async () => {
    m.appel.mockResolvedValue({ statut: 401, error: 'nonce_replayed' });
    expect((await lire()).status).toBe(401);
    m.appel.mockResolvedValue({ app: 'academy' });
    m.deborde.mockReturnValue(true);
    expect((await lire()).status).toBe(429);
    m.deborde.mockReturnValue(false);
    for (const c of ['{', 'x'.repeat(2_001), { ...CORPS, prefixe: 'twenty' }, { ...CORPS, prefixe: '' }, { ...CORPS, prefixe: '%.' }, { ...CORPS, depuis: 'hier' }, { ...CORPS, plus: 1 }]) expect((await lire(c)).status, JSON.stringify(c).slice(0, 80)).toBe(400);
    expect(m.lu).not.toHaveBeenCalled();
  });
  it('refus de lecture traduits', async () => {
    m.lu.mockResolvedValue({ refus: 'membre_introuvable' });
    expect((await lire()).status).toBe(404);
    m.lu.mockResolvedValue({ refus: 'depuis_invalide' });
    expect((await lire()).status).toBe(400);
  });
});
