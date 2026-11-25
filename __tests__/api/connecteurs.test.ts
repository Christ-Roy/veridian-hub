// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '@/lib/auth/rate-limit';

const m = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), emprunt: vi.fn(), partir: vi.fn(), couper: vi.fn(), regler: vi.fn(), trancher: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => m.auth() }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: (u: { supabaseUserId: string }) => u.supabaseUserId }));
vi.mock('@/lib/auth/impersonation', () => ({ isImpersonatedSession: () => m.emprunt() }));
vi.mock('@/lib/auth/recent-auth', () => ({ PREUVE_COMPTE_S: 1, isAuthRecent: (a: number) => a === 1 }));
vi.mock('@/lib/connecteurs/coffre', () => ({ couper: (...a: unknown[]) => m.couper(...a), reglerEcriture: (...a: unknown[]) => m.regler(...a), trancher: (...a: unknown[]) => m.trancher(...a) }));
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
  m.regler.mockResolvedValue(true);
  m.trancher.mockResolvedValue({ fait: true, revoquee: true });
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
  it('fermé : allumer et remplacer sont refusés sans rien toucher ; éteindre et garder, qui retirent un accès, marchent', async () => {
    vi.stubEnv('CONNECTEURS_OUVERTS', '');
    for (const geste of ['allumer', 'remplacer']) expect((await jouer({ connecteur: 'notion', geste })).lieu).toContain('avis=ferme');
    expect([m.regler.mock.calls.length, m.trancher.mock.calls.length]).toEqual([0, 0]);
    expect([(await jouer({ connecteur: 'notion', geste: 'eteindre' })).lieu, (await jouer({ connecteur: 'notion', geste: 'garder' })).lieu]).toEqual(['/dashboard/connexions?avis=lecture', '/dashboard/connexions?avis=garde&service=notion']);
  });
  it('coupé sans confirmation du service : jamais dit « coupé » tout court', async () => {
    m.couper.mockResolvedValue({ coupee: true, revoquee: false });
    expect((await jouer({ connecteur: 'notion', geste: 'couper' })).lieu).toBe('/dashboard/connexions?avis=coupee_ici&service=notion');
  });
  it('écriture : ce service, cette personne ; trancher un rebranchement, et ce qui n\'est pas confirmé', async () => {
    expect((await jouer({ connecteur: 'linear', geste: 'allumer' })).lieu).toContain('avis=ecriture');
    expect([m.regler.mock.calls[0][1], m.regler.mock.calls[0][2].cle, m.regler.mock.calls[0][3]]).toEqual(['h', 'linear', true]);
    m.regler.mockResolvedValue(false);
    expect((await jouer({ connecteur: 'linear', geste: 'allumer' })).lieu).toContain('avis=refus');
    expect((await jouer({ connecteur: 'notion', geste: 'remplacer' })).lieu).toContain('avis=remplace&');
    m.trancher.mockResolvedValue({ fait: true, revoquee: false });
    expect([(await jouer({ connecteur: 'notion', geste: 'remplacer' })).lieu, (await jouer({ connecteur: 'notion', geste: 'garder' })).lieu]).toEqual([expect.stringContaining('avis=remplace_ici'), expect.stringContaining('avis=garde_ici')]);
    m.trancher.mockResolvedValue({ fait: false, revoquee: false });
    expect((await jouer({ connecteur: 'notion', geste: 'remplacer' })).lieu).toContain('avis=tranche');
  });
  it('couper une connexion qui n\'existe pas : dit', async () => {
    m.couper.mockResolvedValue({ coupee: false, revoquee: false });
    expect((await jouer({ connecteur: 'notion', geste: 'couper' })).lieu).toContain('avis=absente');
  });
  it('couper ; service inconnu, geste inconnu, service muet : dits', async () => {
    expect((await jouer({ connecteur: 'notion', geste: 'couper' })).lieu).toBe('/dashboard/connexions?avis=coupee&service=notion');
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
    for (const geste of ['brancher', 'couper', 'allumer', 'eteindre', 'remplacer', 'garder']) expect((await jouer({ connecteur: 'notion', geste }, origine)).statut, geste).toBe(statut);
    expect([m.partir, m.couper, m.regler, m.trancher].map((f) => f.mock.calls.length)).toEqual([0, 0, 0, 0]);
  });
});
