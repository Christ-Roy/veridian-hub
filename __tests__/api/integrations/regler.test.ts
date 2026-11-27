// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ fermee: vi.fn(() => false), auth: vi.fn(), user: vi.fn(), regler: vi.fn(), emprunt: vi.fn(), abonner: vi.fn(async (..._a: unknown[]) => 'sans_objet') }));
vi.mock('@/auth', () => ({ auth: () => m.auth() }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: (u: { supabaseUserId: string }) => u.supabaseUserId }));
vi.mock('@/lib/auth/impersonation', () => ({ isImpersonatedSession: () => m.emprunt() }));
vi.mock('@/lib/delegation/interrupteur', () => ({ reglerIntegration: (...a: unknown[]) => m.regler(...a) }));
vi.mock('@/lib/evenements/allumage', () => ({ suivreAbonnement: (...a: unknown[]) => m.abonner(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));
vi.mock('@/lib/federation/session', () => ({ fermeeIci: async () => m.fermee?.() ?? false, preuveIci: async () => ({ par: 'session' }), reponseFermee: () => new Response(null, { status: 403 }) }));
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
  it('l\'abonnement suit l\'interrupteur ; une demande de clic ou un refus n\'abonne rien', async () => {
    await jouer({ etat: 'eteinte' });
    expect(m.abonner.mock.calls.at(-1)?.[1]).toEqual({ tenantId: T, paire: 'prospection>crm', actif: false });
    m.abonner.mockClear();
    m.regler.mockResolvedValue({ etat: 'a_confirmer', lien: 'https://app.veridian.site/liaisons/confirmer/J', expire_le: '' });
    await jouer();
    m.regler.mockResolvedValue({ refus: 'role_insuffisant' });
    await jouer();
    expect(m.abonner).not.toHaveBeenCalled();
  });
  it('rallumer sans que la source réponde : la liaison est éteinte aussitôt, et on le dit ; couper reste toujours possible', async () => {
    m.abonner.mockResolvedValue('echec');
    m.regler.mockImplementation(async (_d: unknown, x: unknown) => ({ etat: (x as { etat: string }).etat }));
    expect(await jouer({ paire: 'notifuse>crm' })).toEqual([303, '/dashboard/liaisons?avis=source_injoignable']);
    expect(m.regler.mock.calls.map((c) => (c[1] as { etat: string }).etat)).toEqual(['allumee', 'eteinte']);
    expect(await jouer({ paire: 'notifuse>crm', etat: 'eteinte' })).toEqual([303, '/dashboard/liaisons?avis=eteinte']);
    m.abonner.mockResolvedValue('sans_objet');
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
