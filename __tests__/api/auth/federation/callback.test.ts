// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ auth: vi.fn(), signIn: vi.fn(), user: vi.fn(), emprunt: vi.fn(), pret: vi.fn(), terminer: vi.fn(), resoudre: vi.fn(), ticket: vi.fn(), ligne: vi.fn(), ajouter: vi.fn(), ici: vi.fn(), relier: vi.fn(), role: vi.fn(), idpMaj: vi.fn(), audit: vi.fn(), alias: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => m.auth(), signIn: (...a: unknown[]) => m.signIn(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: (...a: unknown[]) => m.ligne(...a) }, tenantIdp: { update: (...a: unknown[]) => m.idpMaj(...a), findUnique: async () => m.alias() }, tenant: { findFirst: async () => ({ slug: 'client-long' }) } } }));
vi.mock('@/lib/delegation/interrupteur', () => ({ roleAuHub: (...a: unknown[]) => m.role(...a) }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/adresses/federation', () => ({ ajouterParFournisseur: (...a: unknown[]) => m.ajouter(...a) }));
vi.mock('@/lib/federation/borne', () => ({ seulementIci: (...a: unknown[]) => m.ici(...a) }));
vi.mock('@/lib/federation/liaison', () => ({ relierParPersonne: (...a: unknown[]) => m.relier(...a) }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user() }));
vi.mock('@/lib/auth/impersonation', () => ({ isImpersonatedSession: () => m.emprunt() }));
vi.mock('@/lib/auth/recent-auth', () => ({ PREUVE_COMPTE_S: 86_400, isAuthRecent: (a: number | undefined) => a === 1 }));
vi.mock('@/lib/federation/idp', () => ({ idpPret: (...a: unknown[]) => m.pret(...a) }));
vi.mock('@/lib/federation/identite', () => ({ resoudreIdentite: (...a: unknown[]) => m.resoudre(...a) }));
vi.mock('@/lib/federation/oidc', () => ({ CHEMIN_RETOUR: '/api/auth/federation/callback', COOKIE_FEDERATION: 'veridian-federation', ouvrir: (c?: string) => (c === 'bon' ? { idp: 'i1', state: 's' } : c === 'ajout' ? { idp: 'i1', state: 's', ajout: { userId: 'U', email: 'pro@client.test' } } : c === 'essai' ? { idp: 'i1', state: 's', essai: { userId: 'U' } } : c === 'relier' ? { idp: 'i1', state: 's', relier: { userId: 'U' } } : null), terminer: (...a: unknown[]) => m.terminer(...a) }));
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
  m.ligne.mockResolvedValue({ id: 'U', email: 'jean@client.test' });
  m.ajouter.mockResolvedValue({ ajoutee: 'pro@client.test' });
  m.ici.mockResolvedValue(true);
  m.relier.mockResolvedValue({ reliee: true });
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
  it('ce navigateur retient la porte : l\'alias, sinon le nom ; une liaison ou un refus ne retiennent rien', async () => {
    m.alias.mockResolvedValue({ alias: 'asd' });
    expect((await revenir()).headers.getSetCookie().join('\n')).toMatch(/veridian-porte=asd;/);
    m.alias.mockResolvedValue(null);
    expect((await revenir()).headers.getSetCookie().join('\n')).toMatch(/veridian-porte=client-long;/);
    m.resoudre.mockResolvedValue({ refus: 'retire' });
    expect((await revenir()).headers.getSetCookie().join('\n')).not.toMatch(/veridian-porte=/);
  });
  it('identifiant inconnu d\'un fournisseur sans adresse : première entrée, identité scellée, aucune session', async () => {
    vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40));
    m.resoudre.mockResolvedValue({ refus: 'non_relie' });
    const r = await revenir();
    expect(lieu(r)).toBe('/auth/premiere-entree');
    expect(r.headers.getSetCookie().join('\n')).toMatch(/veridian-premiere-entree=v1\..*Max-Age=900/i);
    expect([m.ticket.mock.calls.length, m.signIn.mock.calls.length]).toEqual([0, 0]);
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
    ['membre d\'une autre organisation aussi', () => m.ici.mockResolvedValue(false), 'autre_organisation', {}],
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
    expect(await vu({ user: { authAt: 1, federe: true } }), 'session fédérée').toBeNull();
  });
  it('ajout d\'adresse : l\'adresse attendue, aucune session ni organisation active ; refus dit', async () => {
    m.auth.mockResolvedValue({ user: { authAt: 1 } });
    const r = await revenir({ cookie: 'ajout' });
    expect([lieu(r), m.ajouter.mock.calls[0][4]]).toEqual(['/dashboard/settings?adresse=ajoutee', 'pro@client.test']);
    expect([m.resoudre, m.ticket, m.signIn].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
    expect(r.headers.getSetCookie().join('\n')).not.toContain('veridian_org=');
    m.ajouter.mockResolvedValue({ refus: 'autre_adresse' });
    expect(lieu(await revenir({ cookie: 'ajout' }))).toBe('/auth/federation?code=autre_adresse');
  });
  it('la session sait de quelle organisation elle vient', async () => {
    await revenir();
    expect([m.ici.mock.calls[0].slice(1), m.ticket.mock.calls[0].slice(1)]).toEqual([['h', 'T'], ['U', 'T']]);
  });
  it('liaison : la personne qui l\'a demandée, aucune session ni organisation active ; refus dit', async () => {
    m.auth.mockResolvedValue({ user: { authAt: 1 } });
    const r = await revenir({ cookie: 'relier' });
    expect([lieu(r), m.relier.mock.calls[0][3]]).toEqual(['/dashboard/settings?federation=reliee', { id: 'U', email: 'jean@client.test' }]);
    expect([m.resoudre, m.ticket, m.signIn].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
    expect(r.headers.getSetCookie().join('\n')).not.toContain('veridian_org=');
    m.relier.mockResolvedValue({ refus: 'autre_identite' });
    expect(lieu(await revenir({ cookie: 'relier' }))).toBe('/auth/federation?code=autre_identite');
  });
  it('liaison finie par un autre compte, déconnecté, session vieille, d\'emprunt ou fédérée : rien', async () => {
    const avec = async (session: unknown, emprunt = false, id = 'U') => { m.auth.mockResolvedValue(session); m.emprunt.mockReturnValue(emprunt); m.user.mockResolvedValue({ id, email: 'x@client.test' }); return lieu(await revenir({ cookie: 'relier' })); };
    expect([await avec({ user: { authAt: 1 } }, false, 'V'), await avec(null), await avec({ user: { authAt: 0 } }), await avec({ user: { authAt: 1 } }, true), await avec({ user: { authAt: 1, federe: true } })]).toEqual(Array(5).fill('/auth/federation?code=demande_expiree'));
    expect(m.relier).not.toHaveBeenCalled();
  });
  it('un fournisseur SAML ne se termine pas par ce chemin', async () => {
    m.pret.mockResolvedValue({ id: 'i1', tenantId: 'T', protocole: 'saml' });
    expect(lieu(await revenir())).toBe('/auth/federation?code=organisation_indisponible');
    expect(m.terminer).not.toHaveBeenCalled();
  });
  it('essai : le propriétaire qui l\'a demandé ; rien n\'est relié, aucune session ; noté et audité', async () => {
    m.auth.mockResolvedValue({ user: { authAt: 1 } });
    m.ligne.mockResolvedValue({ id: 'U', supabaseUserId: 'h' });
    m.role.mockResolvedValue('owner');
    const r = await revenir({ cookie: 'essai' });
    expect([lieu(r), m.idpMaj.mock.calls[0][0].where, m.audit.mock.calls[0][1].action]).toEqual(['/dashboard/organisation?avis=essai_reussi', { id: 'i1' }, 'federation.idp_essaye']);
    expect(m.pret.mock.calls[0][3], 'même inactif').toBe(true);
    expect([m.resoudre, m.relier, m.ticket, m.signIn].map((f) => f.mock.calls.length)).toEqual([0, 0, 0, 0]);
    await revenir();
    expect(m.pret.mock.calls.at(-1)!.length, 'sans essai, un fournisseur inactif reste fermé').toBe(2);
  });
  it('essai fini par un autre, déconnecté, ou plus propriétaire : rien n\'est noté', async () => {
    m.ligne.mockResolvedValue({ id: 'U', supabaseUserId: 'h' });
    const avec = async (session: unknown, role: string, id = 'U') => { m.auth.mockResolvedValue(session); m.role.mockResolvedValue(role); m.user.mockResolvedValue({ id, email: 'x@c.test' }); return lieu(await revenir({ cookie: 'essai' })); };
    expect([await avec({ user: { authAt: 1 } }, 'owner', 'V'), await avec(null, 'owner'), await avec({ user: { authAt: 1 } }, 'admin'), await avec({ user: { authAt: 1, federe: true } }, 'owner')]).toEqual(Array(4).fill('/auth/federation?code=demande_expiree'));
    expect(m.idpMaj).not.toHaveBeenCalled();
  });
  it('ajout demandé par un autre compte, déconnecté, session vieille, d\'emprunt ou fédérée : rien', async () => {
    const avec = async (session: unknown, emprunt = false, id = 'U') => { m.auth.mockResolvedValue(session); m.emprunt.mockReturnValue(emprunt); m.user.mockResolvedValue({ id, email: 'x@client.test' }); return lieu(await revenir({ cookie: 'ajout' })); };
    expect([await avec({ user: { authAt: 1 } }, false, 'V'), await avec(null), await avec({ user: { authAt: 0 } }), await avec({ user: { authAt: 1 } }, true), await avec({ user: { authAt: 1, federe: true } })]).toEqual(Array(5).fill('/auth/federation?code=demande_expiree'));
    expect(m.ajouter).not.toHaveBeenCalled();
  });
});
