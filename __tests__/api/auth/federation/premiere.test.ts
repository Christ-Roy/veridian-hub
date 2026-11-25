// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '@/lib/auth/rate-limit';

const m = vi.hoisted(() => ({ idp: vi.fn(), ouvrir: vi.fn(), demander: vi.fn(), confirmer: vi.fn(), session: vi.fn() }));
vi.mock('@/lib/federation/conclure', async () => { const { NextResponse: R } = await import('next/server'); return { ouvrirSession: (...a: unknown[]) => m.session(...a), sortieDe: () => ({ refus: (c: string) => new R(null, { status: 303, headers: { location: `refus:${c}` } }) }) }; });
vi.mock('@/lib/federation/idp', () => ({ idpPret: () => m.idp() }));
vi.mock('@/lib/federation/premiere', () => ({ COOKIE_PREMIERE: 'veridian-premiere-entree', ouvrirPremiere: () => m.ouvrir(), demanderPremiere: (...a: unknown[]) => m.demander(...a), confirmerPremiere: (...a: unknown[]) => m.confirmer(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/auth/federation/premiere/route';

const jouer = async (champs: Record<string, string>, origin = 'https://app.veridian.site') => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  const r = await POST(new NextRequest('https://h/x', { method: 'POST', body: f, headers: { origin } }));
  return [r.status, r.headers.get('location')?.replace('https://app.veridian.site/auth/premiere-entree', '')];
};
beforeEach(() => {
  vi.clearAllMocks();
  m.ouvrir.mockReturnValue({ idp: 'i', sub: 's' });
  m.idp.mockResolvedValue({ id: 'i', tenantId: 'T', domaines: [] });
  m.demander.mockResolvedValue('demande');
  m.confirmer.mockResolvedValue({ userId: 'U', hubUserId: 'h', neuf: false });
  m.session.mockResolvedValue(NextResponse.json({ ok: true }));
  vi.spyOn(RateLimiter.prototype, 'enforce').mockReturnValue({ ok: true } as never);
});

describe('POST', () => {
  it('demander : la même suite, attendue ou non', async () => {
    expect(await jouer({ geste: 'demander', email: 'a@asd.test' })).toEqual([303, '?etape=code&email=a%40asd.test']);
    m.demander.mockResolvedValue('trop');
    expect((await jouer({ geste: 'demander', email: 'a@asd.test' }))[1]).toBe('?avis=trop');
    expect((await jouer({ geste: 'demander', email: 'pas une adresse' }))[1]).toBe('?avis=adresse');
  });
  it('confirmer : la session par le même chemin que les autres entrées', async () => {
    expect((await jouer({ geste: 'confirmer', email: 'a@asd.test', code: '123456' }))[0]).toBe(200);
    expect(m.session.mock.calls[0][3]).toEqual({ userId: 'U', hubUserId: 'h', neuf: false });
    m.confirmer.mockResolvedValue({ refus: 'code_faux' });
    expect((await jouer({ geste: 'confirmer', email: 'a@asd.test', code: '0' }))[1]).toContain('avis=code_faux');
    m.confirmer.mockResolvedValue({ refus: 'autre_identite' });
    expect((await jouer({ geste: 'confirmer', email: 'a@asd.test', code: '0' }))[1]).toBe('refus:autre_identite');
    expect(m.session).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['sans identité scellée', () => m.ouvrir.mockReturnValue(null), 'refus:demande_expiree'],
    ['fournisseur fermé', () => m.idp.mockResolvedValue(null), 'refus:organisation_indisponible'],
    ['fournisseur qui affirme des adresses', () => m.idp.mockResolvedValue({ domaines: ['x.fr'] }), 'refus:organisation_indisponible'],
  ])('%s : rien', async (_n, casser, lieu) => {
    casser();
    expect((await jouer({ geste: 'confirmer', email: 'a@asd.test', code: '123456' }))[1]).toBe(lieu);
    expect([m.demander, m.confirmer, m.session].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });
  it('d\'une autre page, ou trop souvent : refusé', async () => {
    expect((await jouer({ geste: 'demander', email: 'a@asd.test' }, 'https://pirate.test'))[0]).toBe(403);
    vi.spyOn(RateLimiter.prototype, 'enforce').mockReturnValue({ ok: false } as never);
    expect((await jouer({ geste: 'demander', email: 'a@asd.test' }))[0]).toBe(429);
  });
});
