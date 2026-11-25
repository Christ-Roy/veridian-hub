// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ auth: vi.fn(), signIn: vi.fn(), user: vi.fn(), emprunt: vi.fn(), pret: vi.fn(), terminer: vi.fn(), resoudre: vi.fn(), ticket: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => m.auth(), signIn: (...a: unknown[]) => m.signIn(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user() }));
vi.mock('@/lib/auth/impersonation', () => ({ isImpersonatedSession: () => m.emprunt() }));
vi.mock('@/lib/auth/recent-auth', () => ({ PREUVE_COMPTE_S: 86_400, isAuthRecent: (a: number | undefined) => a === 1 }));
vi.mock('@/lib/federation/idp', () => ({ idpPret: (...a: unknown[]) => m.pret(...a) }));
vi.mock('@/lib/federation/identite', () => ({ resoudreIdentite: (...a: unknown[]) => m.resoudre(...a) }));
vi.mock('@/lib/federation/oidc', () => ({ CHEMIN_RETOUR: '/api/auth/federation/callback', COOKIE_FEDERATION: 'veridian-federation', ouvrir: (c?: string) => (c === 'bon' ? { idp: 'i1', state: 's' } : null), terminer: (...a: unknown[]) => m.terminer(...a) }));
vi.mock('@/lib/federation/ticket', () => ({ FOURNISSEUR_FEDERATION: 'federation', emettreTicket: (...a: unknown[]) => m.ticket(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));

import { GET } from '@/app/api/auth/federation/callback/route';

const revenir = (o: { cookie?: string; bounce?: boolean } = {}) => GET(new NextRequest('https://0.0.0.0:3000/api/auth/federation/callback?code=c&state=s', { headers: { cookie: [`veridian-federation=${o.cookie ?? 'bon'}`, ...(o.bounce ? ['__Secure-veridian-next=x'] : [])].join('; ') } }));
const lieu = (r: Response) => r.headers.get('location')?.replace('https://app.veridian.site', '');
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue(null);
  m.emprunt.mockReturnValue(false);
  m.user.mockResolvedValue({ id: 'U', email: 'jean@client.test' });
  m.pret.mockResolvedValue({ id: 'i1', tenantId: 'T' });
  m.terminer.mockResolvedValue({ sub: 's', email: 'jean@client.test', emailNie: false, nom: null });
  m.resoudre.mockResolvedValue({ userId: 'U', hubUserId: 'h', neuf: false });
  m.ticket.mockResolvedValue('TICKET');
  m.signIn.mockImplementation(async (_p: string, o: { redirectTo: string }) => `https://app.veridian.site${o.redirectTo}`);
});

describe('GET callback', () => {
  it('session par Auth.js avec le ticket, organisation active posée, transaction détruite ; l\'adresse vue par le fournisseur est la publique', async () => {
    const r = await revenir();
    expect([r.status, lieu(r), m.signIn.mock.calls[0]]).toEqual([303, '/dashboard', ['federation', { ticket: 'TICKET', redirect: false, redirectTo: '/dashboard' }]]);
    expect(String(m.terminer.mock.calls[0][2])).toBe('https://app.veridian.site/api/auth/federation/callback?code=c&state=s');
    const c = r.headers.getSetCookie().join('\n');
    expect(c).toMatch(/veridian_org=T;/);
    expect(c).toMatch(/veridian-federation=;.*Max-Age=0/i);
  });
  it('venu d\'une app : il y retourne', async () => expect(lieu(await revenir({ bounce: true }))).toBe('/api/auth/bounce/complete'));
  it('2FA : le verdict d\'Auth.js fait foi', async () => {
    m.signIn.mockResolvedValue('https://app.veridian.site/auth/mfa?uid=U');
    expect(lieu(await revenir())).toBe('/auth/mfa?uid=U');
  });
  it.each([
    ['sans transaction', () => {}, 'demande_expiree', { cookie: 'autre' }],
    ['fournisseur fermé depuis', () => m.pret.mockResolvedValue(null), 'organisation_indisponible', {}],
    ['réponse invérifiable', () => m.terminer.mockRejectedValue(new Error('signature')), 'reponse_refusee', {}],
    ['identité refusée', () => m.resoudre.mockResolvedValue({ refus: 'domaine_refuse' }), 'domaine_refuse', {}],
    ['Auth.js refuse', () => m.signIn.mockResolvedValue('https://app.veridian.site/login?error=CredentialsSignin'), 'session_refusee', {}],
    ['redirection ailleurs', () => m.signIn.mockResolvedValue('https://pirate.test/x'), 'session_refusee', {}],
  ])('%s : refusé et dit, aucune organisation active, transaction détruite', async (_n, casser, code, o) => {
    casser();
    const r = await revenir(o);
    expect(lieu(r)).toBe(`/auth/federation?code=${code}`);
    const c = r.headers.getSetCookie().join('\n');
    expect(c).not.toContain('veridian_org=');
    expect(c).toMatch(/veridian-federation=;/);
  });
  it('rien n\'ouvre de session avant la vérification complète', async () => {
    m.resoudre.mockResolvedValue({ refus: 'retire' });
    await revenir();
    expect([m.ticket.mock.calls.length, m.signIn.mock.calls.length]).toEqual([0, 0]);
  });
  it('relier un compte : seulement une session récente, jamais d\'emprunt', async () => {
    const vu = async (session: unknown, emprunt = false) => { m.auth.mockResolvedValue(session); m.emprunt.mockReturnValue(emprunt); await revenir(); return m.resoudre.mock.calls.at(-1)![3]; };
    expect(await vu({ user: { authAt: 1 } })).toEqual({ userId: 'U', email: 'jean@client.test' });
    expect([await vu({ user: { authAt: 0 } }), await vu({ user: { authAt: 1 } }, true), await vu(null)]).toEqual([null, null, null]);
  });
});
