// @vitest-environment node
/** Le rebond pendant un emprunt (VER-263) : l'app sait qui est là, et rien n'est fait au nom du client. */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const m = vi.hoisted(() => ({ auth: vi.fn(), audit: vi.fn(), poignees: vi.fn(), orgs: vi.fn(), preinscr: vi.fn(), crm: vi.fn(), fetch: vi.fn() }));
vi.mock('@/auth', () => ({ auth: m.auth }));
vi.mock('@/lib/prisma', () => ({ prisma: { auditLog: { create: m.audit } } }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: async () => ({ id: 'u-client', email: 'c@c', name: null, image: null, supabaseUserId: 'h-client' }), userUuid: () => 'h-client' }));
vi.mock('@/lib/auth/email-proof', () => ({ denyUnlessEmailProven: async () => null }));
vi.mock('@/lib/auth/email-proof-provider', () => ({ isEmailProvenInDb: async () => true }));
vi.mock('@/lib/auth/bounce-next', async (o) => ({ ...(await o<object>()), verifyNextCookie: () => 'https://crm.app.veridian.site/', isRealNavigation: () => true }));
vi.mock('@/lib/delegation/poignee', () => ({ emettrePoignees: m.poignees }));
vi.mock('@/lib/tenants/roles', () => ({ APPS_A_ROLE: ['crm'], organisationsPourRebond: m.orgs }));
vi.mock('@/lib/tenants/preinscription', () => ({ consommerPreinscriptions: m.preinscr }));
vi.mock('@/lib/tenants/actif', () => ({ COOKIE_ACTIF: 'veridian_org', organisationActive: async () => 'T1' }));
vi.mock('@/lib/tenants/membre-seul', () => ({ membreSeul: async () => false }));
vi.mock('@/lib/crm/provision', () => ({ ensureCrmWorkspace: m.crm }));
vi.mock('@/lib/academy/provision', () => ({ ensureAcademyWorkspace: vi.fn() }));
vi.mock('@/lib/federation/obligation', () => ({ fermees: async () => [], tientApp: async () => true, preuveDeSession: () => ({ par: 'session' }) }));
vi.mock('@/lib/tenant-apps', () => ({ getEnabledGatedApps: async () => new Set() }));

import { GET } from '@/app/api/auth/bounce/complete/route';

const go = () => GET(new NextRequest('https://app.veridian.site/api/auth/bounce/complete', { headers: { cookie: '__Secure-veridian-next=x' } }));
const corps = () => JSON.parse(m.fetch.mock.calls[0][1].body) as Record<string, unknown>;
const reponse = (o: object, status = 200) => m.fetch.mockResolvedValue(new Response(JSON.stringify(o), { status }));
const debut = () => Math.floor(Date.now() / 1000);
const emprunt = (o = {}) => ({ user: { id: 'u-client', impersonated: true, impersonatedBy: ADMIN, empruntId: 'e-1', authAt: debut(), ...o } });
const journal = () => m.audit.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', m.fetch);
  Object.assign(process.env, { AUTH_SECRET: 's'.repeat(40), DEPLOY_ENV: 'prod', NEXT_PUBLIC_SITE_URL: 'https://app.veridian.site', CRM_API_URL: 'https://crm.app.veridian.site', CRM_HUB_API_SECRET: 'x' });
  m.poignees.mockResolvedValue([{ hub_tenant_id: 'T1', grant: 'g', expire_le: 'x' }]);
  m.orgs.mockResolvedValue([{ hub_tenant_id: 'T1', role: 'owner', version: 1 }]);
  m.preinscr.mockResolvedValue([]);
  reponse({ magic_link_url: 'https://crm.app.veridian.site/verify?t=1' });
});

describe('rebond pendant un emprunt', () => {
  it('le corps signé dit qui emprunte et jusqu\'à quand ; ni rôle, ni poignée, ni pré-inscription', async () => {
    m.auth.mockResolvedValue(emprunt());
    expect((await go()).headers.get('location')).toBe('https://crm.app.veridian.site/verify?t=1');
    expect(corps()).toMatchObject({ hub_user_id: 'h-client', email: 'c@c', emprunt: { id: 'e-1', par: ADMIN, expire_le: expect.stringMatching(/Z$/) } });
    expect([corps().organisations, corps().delegations]).toEqual([undefined, undefined]);
    expect([m.poignees.mock.calls.length, m.orgs.mock.calls.length, m.preinscr.mock.calls.length]).toEqual([0, 0, 0]);
    expect(journal()).toMatchObject([{ action: 'admin.impersonate.app', actor: `hub_user:${ADMIN}`, targetId: 'u-client', payload: { emprunt: 'e-1', app: 'crm', resultat: 'entre', app_journalise: false } }]);
  });
  it('une app qui garde trace le dit, et c\'est noté', async () => {
    m.auth.mockResolvedValue(emprunt());
    reponse({ magic_link_url: 'https://crm.app.veridian.site/v', emprunt_journalise: true });
    await go();
    expect(journal()[0].payload).toMatchObject({ app_journalise: true });
  });
  it('le client n\'a pas encore l\'app : aucun espace n\'est créé à sa place, le refus est noté', async () => {
    m.auth.mockResolvedValue(emprunt());
    reponse({ error: 'user_not_in_app' }, 400);
    expect((await go()).headers.get('location')).toContain('code=user_not_in_app');
    expect(m.crm).not.toHaveBeenCalled();
    expect(journal()[0].payload).toMatchObject({ resultat: 'user_not_in_app', app_journalise: null });
  });
  it('un emprunt sans trace n\'entre nulle part', async () => {
    m.auth.mockResolvedValue(emprunt({ empruntId: null }));
    expect((await go()).headers.get('location')).toBe('https://app.veridian.site/dashboard');
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it('témoin : de sa propre session, le client porte ses rôles et ses poignées, sans emprunt', async () => {
    m.auth.mockResolvedValue({ user: { id: 'u-client', authAt: debut() } });
    await go();
    expect(corps()).toMatchObject({ organisations: [{ hub_tenant_id: 'T1' }], delegations: [{ grant: 'g' }] });
    expect(corps().emprunt).toBeUndefined();
    expect(journal()).toEqual([]);
  });
});
