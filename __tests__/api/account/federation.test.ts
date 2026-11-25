// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '@/lib/auth/rate-limit';

const m = vi.hoisted(() => ({ user: vi.fn(), ligne: vi.fn(), emprunt: vi.fn(), recent: vi.fn(), de: vi.fn(), liste: vi.fn(), delier: vi.fn(), demarrer: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: (...a: unknown[]) => m.ligne(...a) } } }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user() }));
vi.mock('@/lib/auth/recent-auth', () => ({ PREUVE_COMPTE_S: 1, denyIfImpersonated: () => m.emprunt(), denyUnlessRecentAuth: () => m.recent() }));
vi.mock('@/lib/federation/liaison', () => ({ fournisseurDe: (...a: unknown[]) => m.de(...a), liaisonsDe: (...a: unknown[]) => m.liste(...a), delier: (...a: unknown[]) => m.delier(...a) }));
vi.mock('@/lib/federation/depart', () => ({ partir: (...a: unknown[]) => m.demarrer(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));

import { GET, POST } from '@/app/api/account/federation/route';

const T = '11111111-1111-4111-8111-111111111111';
const poster = (corps: unknown, origin: string | null = 'https://app.veridian.site') => POST(new NextRequest('https://h/x', { method: 'POST', headers: origin ? { origin } : {}, body: JSON.stringify(corps) }));
beforeEach(() => {
  vi.clearAllMocks();
  m.user.mockResolvedValue({ id: 'u' });
  m.ligne.mockResolvedValue({ id: 'u', email: 'j@x.fr', emailVerified: new Date(), supabaseUserId: 'h' });
  m.emprunt.mockResolvedValue(null);
  m.recent.mockResolvedValue(null);
  m.de.mockResolvedValue({ id: 'i1' });
  m.liste.mockResolvedValue([{ tenant_id: T }]);
  m.delier.mockResolvedValue(true);
  m.demarrer.mockResolvedValue({ url: 'https://login.infomaniak.com/authorize?x', poser: (r: { cookies: { set: (n: string, v: string, o: object) => void } }) => r.cookies.set('veridian-federation', 'scelle', { httpOnly: true }) });
  vi.spyOn(RateLimiter.prototype, 'enforce').mockReturnValue({ ok: true } as never);
});
describe('GET', () => {
  it('les siennes ; sans session : rien', async () => {
    expect(await (await GET()).json()).toEqual({ liaisons: [{ tenant_id: T }] });
    m.user.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});
describe('POST', () => {
  it('relier : où aller, transaction scellée pour CETTE personne', async () => {
    const r = await poster({ geste: 'relier', tenant_id: T });
    expect([r.status, await r.json()]).toEqual([200, { ok: true, url: 'https://login.infomaniak.com/authorize?x' }]);
    expect([m.demarrer.mock.calls[0][0], m.demarrer.mock.calls[0][2]]).toEqual([{ id: 'i1' }, { relier: { userId: 'u' } }]);
    expect(r.headers.getSetCookie().join()).toMatch(/veridian-federation=scelle;.*HttpOnly/i);
  });
  it('délier', async () => {
    expect((await poster({ geste: 'delier', tenant_id: T })).status).toBe(200);
    m.delier.mockResolvedValue(false);
    expect((await poster({ geste: 'delier', tenant_id: T })).status).toBe(404);
  });
  it.each([
    ['autre origine', () => {}, 403, 'https://pirate.test'],
    ['sans origine', () => {}, 403, null],
    ['sans session', () => m.user.mockResolvedValue(null), 401, undefined],
    ['emprunt', () => m.emprunt.mockResolvedValue(Response.json({}, { status: 403 })), 403, undefined],
    ['session fédérée ou trop vieille', () => m.recent.mockResolvedValue(Response.json({}, { status: 403 })), 403, undefined],
    ['adresse non prouvée', () => m.ligne.mockResolvedValue({ id: 'u', emailVerified: null }), 403, undefined],
    ['débit', () => vi.spyOn(RateLimiter.prototype, 'enforce').mockReturnValue({ ok: false } as never), 429, undefined],
    ['pas membre, ou sans fournisseur', () => m.de.mockResolvedValue(null), 404, undefined],
    ['fournisseur muet', () => { vi.spyOn(console, 'error').mockImplementation(() => undefined); m.demarrer.mockRejectedValue(new Error('x')); }, 503, undefined],
  ])('%s : refusé, aucune transaction', async (_n, casser, statut, origine) => {
    casser();
    const r = await (origine === undefined ? poster({ geste: 'relier', tenant_id: T }) : poster({ geste: 'relier', tenant_id: T }, origine));
    expect(r.status).toBe(statut);
    expect(r.headers.getSetCookie?.() ?? []).toEqual([]);
  });
  it('corps illisible, champ de plus', async () => {
    for (const c of [{}, { geste: 'relier' }, { geste: 'relier', tenant_id: 'x' }, { geste: 'relier', tenant_id: T, user_id: 'v' }]) expect((await poster(c)).status).toBe(400);
  });
});
