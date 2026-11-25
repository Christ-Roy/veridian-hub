// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '@/lib/auth/rate-limit';

const m = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), emprunt: vi.fn(), partir: vi.fn(), couper: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => m.auth() }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: (u: { supabaseUserId: string }) => u.supabaseUserId }));
vi.mock('@/lib/auth/impersonation', () => ({ isImpersonatedSession: () => m.emprunt() }));
vi.mock('@/lib/auth/recent-auth', () => ({ PREUVE_COMPTE_S: 1, isAuthRecent: (a: number) => a === 1 }));
vi.mock('@/lib/connecteurs/coffre', () => ({ couper: (...a: unknown[]) => m.couper(...a) }));
vi.mock('@/lib/connecteurs/oauth', () => ({ CHEMIN_RETOUR_CONNECTEUR: '/api/connecteurs/retour', COOKIE_CONNECTEUR: 'veridian-connecteur', TRANSACTION_CONNECTEUR_S: 600, partir: (...a: unknown[]) => m.partir(...a) }));
vi.mock('@/lib/connecteurs/porte', () => ({ retourConnecteur: () => 'https://app.veridian.site/api/connecteurs/retour' }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/connecteurs/route';

const jouer = async (champs: Record<string, string>, origin = 'https://app.veridian.site') => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  const r = await POST(new NextRequest('https://0.0.0.0/x', { method: 'POST', body: f, headers: { origin } }));
  return { statut: r.status, lieu: r.headers.get('location')?.replace('https://app.veridian.site', ''), cookie: r.headers.get('set-cookie') };
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CONNECTEURS_OUVERTS', '1');
  m.auth.mockResolvedValue({ user: { authAt: 1 } });
  m.user.mockResolvedValue({ id: 'U', supabaseUserId: 'h' });
  m.emprunt.mockReturnValue(false);
  m.partir.mockResolvedValue({ url: 'https://mcp.notion.com/authorize?x', cookie: 'scelle' });
  m.couper.mockResolvedValue({ coupee: true, revoquee: true });
  vi.spyOn(RateLimiter.prototype, 'enforce').mockReturnValue({ ok: true } as never);
});

describe('POST', () => {
  it('brancher : chez le service, transaction de CETTE personne, cookie borné au retour', async () => {
    const r = await jouer({ connecteur: 'notion', geste: 'brancher' });
    expect([r.statut, r.lieu, m.partir.mock.calls[0][2]]).toEqual([303, 'https://mcp.notion.com/authorize?x', 'U']);
    expect(r.cookie).toMatch(/veridian-connecteur=scelle; Path=\/api\/connecteurs\/retour;.*Max-Age=600;.*Secure; HttpOnly; SameSite=lax/i);
  });
  it('fermé : brancher est refusé AVANT tout départ, couper marche', async () => {
    vi.stubEnv('CONNECTEURS_OUVERTS', '');
    expect((await jouer({ connecteur: 'notion', geste: 'brancher' })).lieu).toBe('/dashboard/connexions?avis=ferme');
    expect(m.partir).not.toHaveBeenCalled();
    expect((await jouer({ connecteur: 'notion', geste: 'couper' })).lieu).toContain('avis=coupee');
  });
  it('couper une connexion qui n\'existe pas : dit', async () => {
    m.couper.mockResolvedValue({ coupee: false, revoquee: false });
    expect((await jouer({ connecteur: 'notion', geste: 'couper' })).lieu).toContain('avis=absente');
  });
  it('couper ; service inconnu, geste inconnu, service muet : dits', async () => {
    expect((await jouer({ connecteur: 'notion', geste: 'couper' })).lieu).toBe('/dashboard/connexions?avis=coupee');
    expect(m.couper.mock.calls[0].slice(1, 3)).toEqual(['h', 'notion']);
    expect((await jouer({ connecteur: 'stripe', geste: 'brancher' })).lieu).toContain('avis=refus');
    expect((await jouer({ connecteur: 'notion', geste: 'x' })).lieu).toContain('avis=refus');
    vi.spyOn(console, 'error').mockReturnValue();
    m.partir.mockRejectedValue(new Error('x'));
    expect((await jouer({ connecteur: 'notion', geste: 'brancher' })).lieu).toContain('avis=injoignable');
  });
  it.each([
    ['autre origine', () => {}, 403, 'https://pirate.test'],
    ['emprunt', () => m.emprunt.mockReturnValue(true), 403, undefined],
    ['session fédérée', () => m.auth.mockResolvedValue({ user: { authAt: 1, federe: true } }), 403, undefined],
    ['preuve vieille', () => m.auth.mockResolvedValue({ user: { authAt: 0 } }), 303, undefined],
    ['déconnecté', () => m.user.mockResolvedValue(null), 303, undefined],
    ['débit', () => vi.spyOn(RateLimiter.prototype, 'enforce').mockReturnValue({ ok: false } as never), 303, undefined],
  ])('%s : rien ne part, rien n\'est coupé', async (_n, casser, statut, origine) => {
    casser();
    expect([(await jouer({ connecteur: 'notion', geste: 'brancher' }, origine)).statut, (await jouer({ connecteur: 'notion', geste: 'couper' }, origine)).statut]).toEqual([statut, statut]);
    expect([m.partir, m.couper].map((f) => f.mock.calls.length)).toEqual([0, 0]);
  });
});
