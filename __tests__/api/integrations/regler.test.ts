// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), regler: vi.fn(), emprunt: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => m.auth() }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: (u: { supabaseUserId: string }) => u.supabaseUserId }));
vi.mock('@/lib/auth/impersonation', () => ({ isImpersonatedSession: () => m.emprunt() }));
vi.mock('@/lib/delegation/interrupteur', () => ({ reglerIntegration: (...a: unknown[]) => m.regler(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/integrations/regler/route';

const T = '11111111-1111-4111-8111-111111111111';
const jouer = async (champs: Record<string, string> = {}, origin: string | null = 'https://app.veridian.site') => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ tenant: T, paire: 'prospection>crm', etat: 'allumee', ...champs })) f.set(k, v);
  const r = await POST(new NextRequest('https://0.0.0.0:3000/api/integrations/regler', { method: 'POST', body: f, headers: origin ? { origin } : {} }));
  return [r.status, r.headers.get('location')?.replace('https://app.veridian.site', '')];
};
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { authAt: 1 } });
  m.user.mockResolvedValue({ supabaseUserId: 'u' });
  m.emprunt.mockReturnValue(false);
  m.regler.mockResolvedValue({ etat: 'eteinte' });
});

describe('POST /api/integrations/regler', () => {
  it('règle pour le compte connecté, jamais pour un compte reçu du formulaire', async () => {
    expect(await jouer({ etat: 'eteinte', hubUserId: 'pirate' })).toEqual([303, '/dashboard/liaisons?avis=eteinte']);
    expect(m.regler.mock.calls[0][1]).toEqual({ tenantId: T, paire: 'prospection>crm', etat: 'eteinte', hubUserId: 'u', client: 'Veridian, page Liaisons', origine: 'https://app.veridian.site' });
  });
  it('première ouverture : rien n\'est allumé, on va à la page de confirmation', async () => {
    m.regler.mockResolvedValue({ etat: 'a_confirmer', lien: 'https://app.veridian.site/liaisons/confirmer/JJ', expire_le: '' });
    expect(await jouer()).toEqual([303, '/liaisons/confirmer/JJ']);
  });
  it('un refus est dit', async () => {
    m.regler.mockResolvedValue({ refus: 'role_insuffisant' });
    expect(await jouer()).toEqual([303, '/dashboard/liaisons?avis=role_insuffisant']);
  });
  it('autre site, sans session, session d\'emprunt, formulaire faux : rien n\'est réglé', async () => {
    expect((await jouer({}, 'https://pirate.test'))[0]).toBe(403);
    expect((await jouer({}, null))[0]).toBe(403);
    m.user.mockResolvedValue(null);
    expect(await jouer()).toEqual([303, '/login?callbackUrl=/dashboard/liaisons']);
    m.user.mockResolvedValue({ supabaseUserId: 'u' });
    m.emprunt.mockReturnValue(true);
    expect((await jouer())[0]).toBe(403);
    m.emprunt.mockReturnValue(false);
    expect(await jouer({ tenant: 'x' })).toEqual([303, '/dashboard/liaisons?avis=refus']);
    expect(await jouer({ etat: 'tout' })).toEqual([303, '/dashboard/liaisons?avis=refus']);
    expect(m.regler).not.toHaveBeenCalled();
  });
});
