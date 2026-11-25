// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '@/lib/auth/rate-limit';

const m = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), emprunt: vi.fn(), role: vi.fn(), poser: vi.fn(), regler: vi.fn(), essai: vi.fn(), partir: vi.fn(), audit: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => m.auth() }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user(), userUuid: (u: { supabaseUserId: string }) => u.supabaseUserId }));
vi.mock('@/lib/auth/impersonation', () => ({ isImpersonatedSession: () => m.emprunt() }));
vi.mock('@/lib/auth/recent-auth', () => ({ PREUVE_COMPTE_S: 1, isAuthRecent: (a: number) => a === 1 }));
vi.mock('@/lib/delegation/interrupteur', () => ({ roleAuHub: () => m.role() }));
vi.mock('@/lib/federation/depart', () => ({ partir: (...a: unknown[]) => m.partir(...a) }));
vi.mock('@/lib/federation/idp', async (o) => ({ ...(await o<object>()), poserIdp: (...a: unknown[]) => m.poser(...a), reglerIdpLibre: (...a: unknown[]) => m.regler(...a), idpEssai: () => m.essai() }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/organisations/fournisseur/route';

const T = '11111111-1111-4111-8111-111111111111';
const OIDC = { geste: 'poser', protocole: 'oidc', issuer: 'https://login.infomaniak.com', client_id: 'c', client_secret: 'un-secret' };
const jouer = async (champs: Record<string, string>, origin = 'https://app.veridian.site') => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ tenant: T, ...champs })) f.set(k, v);
  const r = await POST(new NextRequest('https://0.0.0.0/x', { method: 'POST', body: f, headers: { origin } }));
  return [r.status, r.headers.get('location')?.replace('https://app.veridian.site/dashboard/organisation?avis=', '')];
};
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { authAt: 1 } });
  m.user.mockResolvedValue({ id: 'U', supabaseUserId: 'h' });
  m.emprunt.mockReturnValue(false);
  m.role.mockResolvedValue('owner');
  m.poser.mockResolvedValue({ id: 'i' });
  m.regler.mockResolvedValue({ ok: true });
  m.essai.mockResolvedValue({ id: 'i' });
  m.partir.mockResolvedValue({ url: 'https://login.infomaniak.com/authorize', poser: () => {} });
  vi.spyOn(RateLimiter.prototype, 'enforce').mockReturnValue({ ok: true } as never);
});

describe('POST', () => {
  it('poser OIDC ou SAML : en libre-service, sans domaine, le secret jamais au journal', async () => {
    expect(await jouer({ ...OIDC, domaines: 'client.test', creation_auto: 'true' })).toEqual([303, 'fournisseur_pose']);
    expect(m.poser.mock.calls[0][1]).toMatchObject({ tenantId: T, libreService: true, acteur: 'user:U', reglage: { domaines: [], creation_auto: false } });
    expect(m.poser.mock.calls[0][1]).not.toHaveProperty('alias');
    expect(JSON.stringify(m.audit.mock.calls)).not.toContain('un-secret');
    expect(await jouer({ geste: 'poser', protocole: 'saml', issuer: 'urn:x', sso_url: 'https://idp.test/sso', certificat: 'A'.repeat(120) })).toEqual([303, 'fournisseur_pose']);
    expect(m.poser.mock.calls[1][1].reglage.protocole).toBe('saml');
  });
  it('un refus se dit', async () => {
    m.poser.mockResolvedValue({ refus: 'issuer_refuse' });
    expect((await jouer(OIDC))[1]).toBe('issuer_refuse');
    expect((await jouer({ ...OIDC, client_secret: '' }))[1]).toBe('fournisseur_incomplet');
    expect((await jouer({ geste: 'autre' }))[1]).toBe('refus');
  });
  it('essayer : vers le fournisseur, pour LUI ; injoignable ou absent, dit', async () => {
    expect(await jouer({ geste: 'essayer' })).toEqual([303, 'https://login.infomaniak.com/authorize']);
    expect(m.partir.mock.calls[0][2]).toEqual({ essai: { userId: 'U' } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.partir.mockRejectedValue(new Error('x'));
    expect((await jouer({ geste: 'essayer' }))[1]).toBe('fournisseur_injoignable');
    m.essai.mockResolvedValue(null);
    expect((await jouer({ geste: 'essayer' }))[1]).toBe('absent');
  });
  it.each([['activer', 'fournisseur_actif'], ['couper', 'fournisseur_coupe'], ['retirer', 'fournisseur_retire']])('%s : fait et audité', async (geste, avis) => {
    expect((await jouer({ geste }))[1]).toBe(avis);
    expect(m.audit.mock.calls[0][1].action).toBe(`federation.idp_${geste}`);
    m.regler.mockResolvedValue({ refus: 'essai_manquant' });
    expect((await jouer({ geste }))[1]).toBe('essai_manquant');
  });
  it.each([
    ['autre origine', () => {}, 403, 'https://pirate.test'],
    ['session d\'emprunt', () => m.emprunt.mockReturnValue(true), 403, undefined],
    ['session fédérée', () => m.auth.mockResolvedValue({ user: { authAt: 1, federe: true } }), 403, undefined],
    ['preuve trop vieille', () => m.auth.mockResolvedValue({ user: { authAt: 0 } }), 303, undefined],
    ['déconnecté', () => m.auth.mockResolvedValue(null), 303, undefined],
    ['admin, pas propriétaire', () => m.role.mockResolvedValue('admin'), 303, undefined],
    ['membre', () => m.role.mockResolvedValue('member'), 303, undefined],
    ['trop souvent', () => vi.spyOn(RateLimiter.prototype, 'enforce').mockReturnValue({ ok: false } as never), 303, undefined],
  ])('%s : rien n\'est posé', async (_n, casser, statut, origine) => {
    casser();
    expect((await jouer(OIDC, origine))[0]).toBe(statut);
    expect((await jouer({ geste: 'activer' }, origine))[0]).toBe(statut);
    expect([m.poser, m.regler, m.partir].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });
});
