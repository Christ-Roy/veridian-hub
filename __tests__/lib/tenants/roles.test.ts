// @vitest-environment node
/** Rôle porté par le Hub : fermé par défaut, jamais une promotion par erreur, et « appliqué » veut dire relu. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheOutils } from '@/lib/mcp/cache';
import { APPS_A_ROLE, organisationsPourRebond, pousserRole, roleOrg, rolePorteOuvert } from '@/lib/tenants/roles';

const CREE = new Date('2026-01-01');
const ENTRE = new Date('2026-02-01');
const CHANGE = new Date('2026-03-01');
let tenants: any[];
let membres: any[];
const users = [{ supabaseUserId: 'u', email: 'client@x.fr' }, { supabaseUserId: 'p', email: 'prop@x.fr' }, { supabaseUserId: 't', email: 'e2e-sso-a-b@veridian.site' }];
const db = {
  tenant: { findMany: async ({ where }: any) => { expect(where.deletedAt).toBeNull(); return tenants.filter((x) => !where.status.notIn.includes(x.status) && (x.userId === where.OR[0].userId || where.OR[1].id.in.includes(x.id))); } },
  tenantMember: { findMany: async ({ where }: any) => membres.filter((x) => x.userId === where.userId && !x.deletedAt) },
  user: { findMany: async ({ where }: any) => users.filter((x) => where.supabaseUserId.in.includes(x.supabaseUserId)), findFirst: async ({ where }: any) => users.find((x) => x.supabaseUserId === where.supabaseUserId) ?? null },
} as never;
const MARQUE = { organisation_de_test: { expire_le: new Date(Date.now() + 3_600_000).toISOString() } };
const TOUS = { NODE_ENV: 'test', ROLE_PORTE: 'tous', CRM_API_URL: 'https://crm.test', CRM_HUB_API_SECRET: 's' } as NodeJS.ProcessEnv;
const AVEC_ACADEMY = { ...TOUS, ACADEMY_API_URL: 'https://academy.test', ACADEMY_HUB_API_SECRET: 'sa' } as NodeJS.ProcessEnv;
beforeEach(() => {
  tenants = [{ id: 'A', userId: 'u', status: 'active', createdAt: CREE }, { id: 'B', userId: 'p', status: 'active', createdAt: CREE }, { id: 'S', userId: 'u', status: 'suspended', createdAt: CREE }, { id: 'T', userId: 't', status: 'active', createdAt: CREE }];
  membres = [{ tenantId: 'B', userId: 'u', role: 'admin', roleLe: CHANGE, joinedAt: ENTRE }, { tenantId: 'T', userId: 'u', role: 'bizarre', roleLe: null, joinedAt: ENTRE }, { tenantId: 'A', userId: 'x', role: 'owner', joinedAt: ENTRE, deletedAt: CHANGE }];
  vi.stubEnv('CRM_API_URL', 'https://crm.test');
  vi.stubEnv('CRM_HUB_API_SECRET', 's');
  vi.stubEnv('ACADEMY_API_URL', 'https://academy.test');
  vi.stubEnv('ACADEMY_HUB_API_SECRET', 'sa');
});

describe('roleOrg', () => {
  it('un rôle inconnu vaut member', () => expect(['owner', 'proprietaire', 'admin', 'member', 'bizarre', null, undefined].map((r) => roleOrg(r))).toEqual(['owner', 'owner', 'admin', 'member', 'member', 'member', 'member']));
});

describe('rolePorteOuvert', () => {
  it('fermé par défaut ; ouvert pour une organisation nommée, toutes, ou MARQUÉE de test', () => {
    const o = (id: string, metadata: unknown, ROLE_PORTE?: string) => rolePorteOuvert({ id, metadata }, { NODE_ENV: 'test', ROLE_PORTE });
    expect([o('A', {}), o('A', null), o('A', {}, ''), o('A', {}, 'B'), o('A', {}, 'AA')]).toEqual([false, false, false, false, false]);
    expect([o('A', {}, 'B, A'), o('A', {}, 'tous'), o('A', MARQUE)]).toEqual([true, true, true]);
  });
});

describe('organisationsPourRebond', () => {
  it('chaque organisation vivante, son rôle et sa version ; ni suspendue, ni retirée', async () => {
    expect(await organisationsPourRebond(db, 'u', TOUS)).toEqual([
      { hub_tenant_id: 'A', role: 'owner', version: CREE.getTime() },
      { hub_tenant_id: 'B', role: 'admin', version: CHANGE.getTime() },
      { hub_tenant_id: 'T', role: 'member', version: ENTRE.getTime() },
    ]);
    expect(await organisationsPourRebond(db, 'x', TOUS)).toEqual([]);
  });
  it('fermé : seule une organisation marquée part ; une adresse ressemblante ne suffit pas', async () => {
    expect(await organisationsPourRebond(db, 'u', { NODE_ENV: 'test' }), 'T appartient à e2e-sso-…, non marquée').toEqual([]);
    tenants[3].metadata = MARQUE;
    expect((await organisationsPourRebond(db, 'u', { NODE_ENV: 'test' })).map((x) => x.hub_tenant_id)).toEqual(['T']);
  });
});

describe('pousserRole', () => {
  const crm = (reponse: Response | (() => Response), relu: unknown = { hub_tenant_id: 'B', hub_role: 'admin', native_admin: true, workspace_id: 'w' }) => {
    const posts: any[] = [];
    const f = (async (u: string, i: RequestInit = {}) => {
      if ((i.method ?? 'GET') === 'GET') return relu === 500 ? new Response('', { status: 500 }) : Response.json({ found: true, workspaces: [relu, { workspace_id: 'autre', hub_tenant_id: 'Z', hub_role: null, native_admin: false }] });
      posts.push({ u, corps: JSON.parse(String(i.body)), h: i.headers });
      return typeof reponse === 'function' ? reponse() : reponse;
    }) as unknown as typeof fetch;
    return { f, posts };
  };
  const pousser = async (c: ReturnType<typeof crm>, env = TOUS) => (await pousserRole(db, { tenantId: 'B', hubUserId: 'u' }, { env, fetchImpl: c.f }))[0];

  it('envoie ce rôle, dans cette organisation seule, signé, puis relit', async () => {
    const c = crm(Response.json({ applied: true, native_role: 'Admin' }));
    expect(await pousser(c)).toEqual({ app: 'crm', etat: 'applique' });
    expect(c.posts).toHaveLength(1);
    expect(c.posts[0]).toMatchObject({ u: 'https://crm.test/api/hub/members/role', corps: { hub_tenant_id: 'B', hub_user_id: 'u', email: 'client@x.fr', role: 'admin', version: CHANGE.getTime() } });
    expect(c.posts[0].h['X-Veridian-Hub-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(APPS_A_ROLE).toEqual(['crm', 'academy']);
  });
  it('Academy reçoit le même rôle, signé de SON secret, et est relue chez elle', async () => {
    const c = crm(() => Response.json({ applied: true, native_role: 'admin' }));
    expect(await pousserRole(db, { tenantId: 'B', hubUserId: 'u' }, { env: AVEC_ACADEMY, fetchImpl: c.f })).toEqual([{ app: 'crm', etat: 'applique' }, { app: 'academy', etat: 'applique' }]);
    const [a, b] = ['crm', 'academy'].map((x) => c.posts.find((p) => p.u === `https://${x}.test/api/hub/members/role`)!);
    expect(b.corps).toEqual(a.corps);
    expect(b.h['X-Veridian-Hub-Signature']).not.toBe(a.h['X-Veridian-Hub-Signature']);
  });
  it('Academy absente de l\'environnement : dit, et rien ne lui part', async () => {
    const c = crm(Response.json({ applied: true }));
    expect((await pousserRole(db, { tenantId: 'B', hubUserId: 'u' }, { env: TOUS, fetchImpl: c.f }))[1]).toMatchObject({ app: 'academy', etat: 'sans_effet' });
    expect(c.posts).toHaveLength(1);
  });
  it('oublie les outils en cache du compte : un promu voit les siens tout de suite, les autres comptes gardent les leurs', async () => {
    cacheOutils.set('twenty:u', { a: 1, outils: [] });
    cacheOutils.set('twenty:autre', { a: 1, outils: [] });
    await pousserRole(db, { tenantId: 'B', hubUserId: 'u' }, { env: TOUS, fetchImpl: (async () => new Response('', { status: 500 })) as never });
    expect([cacheOutils.has('twenty:u'), cacheOutils.has('twenty:autre')]).toEqual([false, true]);
    cacheOutils.clear();
  });
  it('fermé, ou compte hors de l\'organisation : rien n\'est envoyé', async () => {
    const c = crm(Response.json({ applied: true }));
    expect((await pousser(c, { NODE_ENV: 'test', CRM_API_URL: 'https://crm.test', CRM_HUB_API_SECRET: 's' })).etat).toBe('ferme');
    membres = [];
    expect((await pousser(c)).etat).toBe('ferme');
    expect(c.posts).toEqual([]);
  });
  it('rétrogradé : le droit natif relu doit être tombé', async () => {
    membres[0].role = 'member';
    expect((await pousser(crm(Response.json({ applied: true }), { hub_tenant_id: 'B', hub_role: 'member', native_admin: true, workspace_id: 'w' }))).etat, 'l\'app dit oui et garde Admin').toBe('echec');
    expect((await pousser(crm(Response.json({ applied: true }), { hub_tenant_id: 'B', hub_role: 'member', native_admin: false, workspace_id: 'w' }))).etat).toBe('applique');
  });
  it.each([
    ['pas membre', Response.json({ applied: false, reason: 'not_member' }), 'sans_effet'],
    ['espace non relié', Response.json({ error: 'tenant_not_linked' }, { status: 404 }), 'sans_effet'],
    ['dernier admin', Response.json({ applied: false, reason: 'last_admin' }), 'refuse'],
    ['rôle sur mesure', Response.json({ applied: false, reason: 'native_custom' }), 'refuse'],
    ['déjà à jour, relu', Response.json({ applied: false, reason: 'unchanged' }), 'applique'],
    ['404 nu : route absente', new Response('', { status: 404 }), 'echec'],
    ['500', new Response('', { status: 500 }), 'echec'],
    ['200 illisible', new Response('ok'), 'echec'],
  ])('%s', async (_n, r, etat) => expect((await pousser(crm(r))).etat).toBe(etat));
  it('pas relu, ou relu sans droit natif, ou sur un autre espace : échec, jamais « appliqué »', async () => {
    for (const relu of [500, { hub_tenant_id: 'B', hub_role: 'admin', workspace_id: 'w' }, { hub_tenant_id: 'Z', hub_role: 'admin', native_admin: true, workspace_id: 'w' }]) {
      expect((await pousser(crm(() => Response.json({ applied: true }), relu))).etat).toBe('echec');
    }
  });
});
