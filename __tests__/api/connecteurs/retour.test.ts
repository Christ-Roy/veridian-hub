// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ user: vi.fn(), emprunt: vi.fn(), ouvrir: vi.fn(), terminer: vi.fn(), garder: vi.fn() }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: (u: { supabaseUserId: string }) => u.supabaseUserId }));
vi.mock('@/lib/auth/recent-auth', () => ({ denyIfImpersonated: () => m.emprunt() }));
vi.mock('@/lib/connecteurs/coffre', () => ({ garder: (...a: unknown[]) => m.garder(...a) }));
vi.mock('@/lib/connecteurs/oauth', () => ({ CHEMIN_RETOUR_CONNECTEUR: '/api/connecteurs/retour', COOKIE_CONNECTEUR: 'veridian-connecteur', ouvrirTransaction: () => m.ouvrir(), terminer: (...a: unknown[]) => m.terminer(...a) }));
vi.mock('@/lib/connecteurs/porte', () => ({ retourConnecteur: () => 'https://app.veridian.site/api/connecteurs/retour' }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { GET } from '@/app/api/connecteurs/retour/route';

const revenir = async (q = 'code=c&state=s') => { const r = await GET(new NextRequest(`https://0.0.0.0/api/connecteurs/retour?${q}`)); return { avis: r.headers.get('location')?.split('avis=')[1], cookie: r.headers.get('set-cookie') }; };
beforeEach(() => {
  vi.clearAllMocks();
  m.user.mockResolvedValue({ id: 'U', supabaseUserId: 'h' });
  m.emprunt.mockResolvedValue(null);
  m.ouvrir.mockReturnValue({ cle: 'notion', userId: 'U' });
  m.terminer.mockResolvedValue({ acces: 'a', refresh: null, expireLe: null });
});

describe('GET', () => {
  it('gardé pour la personne qui l\'a ouvert ; transaction détruite ; l\'adresse vue par le service est la publique', async () => {
    const r = await revenir();
    expect([r.avis, m.garder.mock.calls[0].slice(1, 3), String(m.terminer.mock.calls[0][2])]).toEqual(['branchee', ['h', 'notion'], 'https://app.veridian.site/api/connecteurs/retour?code=c&state=s']);
    expect(r.cookie).toMatch(/veridian-connecteur=;.*Max-Age=0/i);
  });
  it.each([
    ['sans transaction', () => m.ouvrir.mockReturnValue(null), 'expiree'],
    ['autre compte', () => m.user.mockResolvedValue({ id: 'V', supabaseUserId: 'v' }), 'expiree'],
    ['déconnecté', () => m.user.mockResolvedValue(null), 'expiree'],
    ['session d\'emprunt', () => m.emprunt.mockResolvedValue(new Response('', { status: 403 })), 'expiree'],
    ['échange refusé', () => { vi.spyOn(console, 'error').mockReturnValue(); m.terminer.mockRejectedValue(new Error('state')); }, 'echec'],
  ])('%s : rien n\'est gardé', async (_n, casser, avis) => {
    casser();
    expect((await revenir()).avis).toBe(avis);
    expect(m.garder).not.toHaveBeenCalled();
  });
  it('jamais en cache, et le code ne fuit pas par l\'adresse d\'origine', async () => {
    const r = await GET(new NextRequest('https://0.0.0.0/api/connecteurs/retour?code=c&state=s'));
    expect([r.headers.get('cache-control'), r.headers.get('referrer-policy'), r.headers.get('location')?.includes('code=')]).toEqual(['no-store', 'no-referrer', false]);
  });
  it('refusé chez le service : dit, sans échange', async () => {
    expect((await revenir('error=access_denied')).avis).toBe('refusee');
    expect(m.terminer).not.toHaveBeenCalled();
  });
});
