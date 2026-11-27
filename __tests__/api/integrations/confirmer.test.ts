// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ fermee: vi.fn(() => false), auth: vi.fn(), user: vi.fn(), confirmer: vi.fn(), regler: vi.fn(), abonner: vi.fn(async (..._a: unknown[]) => 'sans_objet'), emprunt: vi.fn(), recent: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => m.auth() }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: (u: { supabaseUserId: string }) => u.supabaseUserId }));
vi.mock('@/lib/auth/impersonation', () => ({ isImpersonatedSession: () => m.emprunt() }));
vi.mock('@/lib/auth/recent-auth', () => ({ isAuthRecent: (...a: unknown[]) => m.recent(...a), PREUVE_COMPTE_S: 1 }));
vi.mock('@/lib/delegation/interrupteur', () => ({ lireDemande: async () => ({ tenantId: 'T' }), confirmerDemande: (...a: unknown[]) => m.confirmer(...a), reglerIntegration: (...a: unknown[]) => m.regler(...a) }));
vi.mock('@/lib/evenements/allumage', () => ({ suivreAbonnement: (...a: unknown[]) => m.abonner(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));
vi.mock('@/lib/federation/session', () => ({ fermeeIci: async () => m.fermee?.() ?? false, preuveIci: async () => ({ par: 'session' }), reponseFermee: () => new Response(null, { status: 403 }) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/integrations/confirmer/route';

const jouer = (origin: string | null = 'https://app.veridian.site') => {
  const f = new FormData();
  f.set('jeton', 'J');
  return POST(new NextRequest('https://0.0.0.0:3000/api/integrations/confirmer', { method: 'POST', body: f, headers: origin ? { origin } : {} }));
};
const vers = async (r: Promise<Response>) => { const x = await r; return [x.status, x.headers.get('location')?.replace('https://app.veridian.site', '')]; };
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { authAt: 1 } });
  m.user.mockResolvedValue({ supabaseUserId: 'u' });
  m.emprunt.mockReturnValue(false);
  m.recent.mockReturnValue(true);
  m.confirmer.mockResolvedValue({ ok: true });
});

describe('POST /api/integrations/confirmer', () => {
  it('le clic du compte connecté ; refusé : page de refus', async () => {
    expect(await vers(jouer())).toEqual([303, '/liaisons/confirmer/fait']);
    expect(m.confirmer.mock.calls[0].slice(1)).toEqual(['J', 'u']);
    m.confirmer.mockResolvedValue({ ok: false });
    expect(await vers(jouer())).toEqual([303, '/liaisons/confirmer/refus']);
  });
  it('un événement sans abonnement à la source : la liaison s\'éteint aussitôt, et c\'est dit', async () => {
    m.confirmer.mockResolvedValue({ ok: true, paire: 'notifuse>crm', tenantId: 'T' });
    m.abonner.mockResolvedValueOnce('echec');
    expect(await vers(jouer())).toEqual([303, '/liaisons/confirmer/source']);
    expect(m.regler.mock.calls[0][1]).toMatchObject({ tenantId: 'T', paire: 'notifuse>crm', etat: 'eteinte' });
    m.abonner.mockResolvedValueOnce('fait');
    expect(await vers(jouer())).toEqual([303, '/liaisons/confirmer/fait']);
    expect(m.regler).toHaveBeenCalledTimes(1);
  });
  it('un formulaire vide ou illisible ne confirme rien d\'autre qu\'un jeton vide, donc rien', async () => {
    m.confirmer.mockResolvedValue({ ok: false });
    const r = await POST(new NextRequest('https://0.0.0.0:3000/api/integrations/confirmer', { method: 'POST', body: 'x', headers: { origin: 'https://app.veridian.site', 'content-type': 'text/plain' } }));
    expect([r.status, m.confirmer.mock.calls[0][1]]).toEqual([303, '']);
  });
  it('depuis un autre site, sans origine, session d\'emprunt, pas connecté, connexion ancienne : rien n\'est confirmé', async () => {
    expect((await jouer('https://evil.example')).status).toBe(403);
    expect((await jouer(null)).status).toBe(403);
    m.emprunt.mockReturnValue(true);
    expect((await jouer()).status).toBe(403);
    m.emprunt.mockReturnValue(false);
    m.recent.mockReturnValue(false);
    expect(await vers(jouer())).toEqual([303, '/liaisons/confirmer/ancienne']);
    m.user.mockResolvedValue(null);
    expect((await vers(jouer()))[1]).toContain('/login');
    expect(m.confirmer).not.toHaveBeenCalled();
  });
});
