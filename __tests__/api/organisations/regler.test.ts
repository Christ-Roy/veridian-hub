// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ user: vi.fn(), emprunt: vi.fn(), role: vi.fn(), regler: vi.fn() }));
vi.mock('@/auth', () => ({ auth: async () => ({ user: {} }) }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: (u: { supabaseUserId: string }) => u.supabaseUserId }));
vi.mock('@/lib/auth/impersonation', () => ({ isImpersonatedSession: () => m.emprunt() }));
vi.mock('@/lib/delegation/interrupteur', () => ({ roleAuHub: (...a: unknown[]) => m.role(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/organisations/reglage', async (o) => ({ ...(await o<object>()), reglerOrganisation: (...a: unknown[]) => m.regler(...a) }));

import { POST } from '@/app/api/organisations/regler/route';

const T = '11111111-1111-4111-8111-111111111111';
const jouer = async (champs: Record<string, string | File> = {}, origin = 'https://app.veridian.site') => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ tenant: T, type: 'organisation', nom_affiche: 'Atelier', couleur_primaire: '#0B5FFF', couleur_accent: '', ...champs })) f.set(k, v);
  const r = await POST(new NextRequest('https://0.0.0.0/x', { method: 'POST', body: f, headers: { origin } }));
  return [r.status, r.headers.get('location')?.replace('https://app.veridian.site', '')];
};
beforeEach(() => {
  vi.clearAllMocks();
  m.user.mockResolvedValue({ supabaseUserId: 'u' });
  m.emprunt.mockReturnValue(false);
  m.role.mockResolvedValue('owner');
  m.regler.mockResolvedValue({ emissions: [{ etat: 'applique' }] });
});

describe('POST régler', () => {
  it('propriétaire ou admin ; l\'écran ne reçoit ni modules ni réglages d\'app', async () => {
    expect(await jouer({ modules: 'academy', reglages: '{}' })).toEqual([303, '/dashboard/organisation?avis=enregistre']);
    expect(m.regler.mock.calls[0][1]).toMatchObject({ tenantId: T, acteur: 'user:u', reglage: { type: 'organisation', nom_affiche: 'Atelier', couleur_primaire: '#0B5FFF', couleur_accent: null } });
    expect(m.regler.mock.calls[0][1].reglage).not.toHaveProperty('modules');
    m.regler.mockResolvedValue({ emissions: [{ etat: 'echec' }] });
    expect((await jouer())[1]).toContain('partiel');
  });
  it('logo : reçu, retiré, ou inchangé', async () => {
    await jouer({ logo: new File([Buffer.from('x')], 'l.png') });
    await jouer({ retirer_logo: '1' });
    await jouer();
    expect(m.regler.mock.calls.map((c) => (c[1].logo === undefined ? 'inchangé' : c[1].logo === null ? 'retiré' : c[1].logo.toString()))).toEqual(['x', 'retiré', 'inchangé']);
  });
  it('membre, étranger, autre site, emprunt, sans session, valeurs fausses : rien n\'est réglé', async () => {
    for (const role of ['member', null]) { m.role.mockResolvedValue(role); expect((await jouer())[1]).toContain('role_insuffisant'); }
    m.role.mockResolvedValue('owner');
    expect((await jouer({}, 'https://pirate.test'))[0]).toBe(403);
    m.emprunt.mockReturnValue(true);
    expect((await jouer())[0]).toBe(403);
    m.emprunt.mockReturnValue(false);
    expect((await jouer({ couleur_primaire: 'red' }))[1]).toContain('refus');
    expect((await jouer({ tenant: 'x' }))[1]).toContain('refus');
    m.user.mockResolvedValue(null);
    expect((await jouer())[1]).toContain('/login');
    expect(m.regler).not.toHaveBeenCalled();
  });
});
