// @vitest-environment node
/** Appartenance : un seul écrivain, un retrait relu, une suspension dite app par app. */
import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { basculerSuspension, nonCoupees, rejoindre, retirer, type DbMembres } from '@/lib/tenants/membres';

import { parcourir } from '../../contrat/source';

type L = Record<string, any>;
let tenant: L | null;
let users: L[];
let membres: L[];
let audits: L[];
let invitations: L[];
const trouve = (w: L) => membres.find((m) => m.tenantId === w.tenantId_userId.tenantId && m.userId === w.tenantId_userId.userId) ?? null;
const db = {
  tenant: { findFirst: async ({ where }: L) => (tenant && tenant.id === where.id ? tenant : null), update: async ({ data }: L) => Object.assign(tenant!, data) },
  user: { findFirst: async ({ where }: L) => users.find((u) => u.supabaseUserId === where.supabaseUserId) ?? null },
  tenantMember: {
    findUnique: async ({ where }: L) => { const l = trouve(where); return l && { ...l }; },
    upsert: async ({ where, create, update }: L) => { const l = trouve(where); if (l) Object.assign(l, update); else membres.push({ deletedAt: null, ...create }); },
    update: async ({ where, data }: L) => Object.assign(trouve(where)!, data),
  },
  crossAppInvitation: {
    findMany: async ({ where }: L) => invitations.filter((i) => i.inviteeEmail.toLowerCase() === where.inviteeEmail.equals.toLowerCase() && !i.acceptedAt && i.expiresAt > where.expiresAt.gt),
    updateMany: async ({ where, data }: L) => { for (const i of invitations) if (where.id.in.includes(i.id)) Object.assign(i, data); },
  },
  auditLog: { create: async ({ data }: L) => { audits.push(data); } },
} as unknown as DbMembres;

beforeEach(() => {
  tenant = { id: 'T', userId: 'u-prop', status: 'active', notifuseWorkspaceSlug: 'esp', metadata: { crm: { workspace_id: 'w-crm' } } };
  users = [{ supabaseUserId: 'u-prop', email: 'prop@x.fr', emailVerified: new Date() }, { supabaseUserId: 'u-m', email: 'm@x.fr', emailVerified: new Date() }, { supabaseUserId: 'u-flou', email: 'f@x.fr', emailVerified: null }];
  membres = [];
  audits = [];
  invitations = [];
  for (const a of ['NOTIFUSE', 'PROSPECTION', 'CRM', 'ACADEMY', 'ANALYTICS']) {
    vi.stubEnv(`${a}_API_URL`, `https://${a.toLowerCase()}.test`);
    vi.stubEnv(`${a}_HUB_API_SECRET`, 's');
  }
});
const joindre = (o: L = {}) => rejoindre(db, { tenantId: 'T', hubUserId: 'u-m', origine: 'invitation', acteur: 'test', ...o });

describe('rejoindre', () => {
  it('membre, jamais plus, avec son origine et son audit ; deux fois : rien de plus', async () => {
    expect(await joindre()).toEqual({ cree: true, role: 'member' });
    expect(membres[0]).toMatchObject({ role: 'member', origine: 'invitation', ajoutePar: 'test' });
    expect(await joindre()).toEqual({ cree: false, role: 'member' });
    expect(audits).toHaveLength(1);
  });
  it('une invitation ou une reprise ne donne ni admin ni owner ; un opérateur, si, et il change le rôle', async () => {
    for (const origine of ['invitation', 'reprise']) for (const role of ['admin', 'owner', 'dieu']) await expect(joindre({ origine, role })).rejects.toMatchObject({ code: 'role_refuse' });
    expect(membres).toEqual([]);
    expect(await joindre({ origine: 'operateur', role: 'owner' })).toEqual({ cree: true, role: 'owner' });
    expect(await joindre({ origine: 'invitation' }), 'une invitation ne rétrograde pas').toEqual({ cree: false, role: 'owner' });
    expect(await joindre({ origine: 'operateur', role: 'admin' })).toEqual({ cree: true, role: 'admin' });
  });
  it('tenant suspendu ou absent, compte inconnu, adresse non prouvée : rien n\'est écrit', async () => {
    await expect(joindre({ hubUserId: 'u-flou' })).rejects.toMatchObject({ code: 'adresse_non_prouvee' });
    await expect(joindre({ hubUserId: 'u-x' })).rejects.toMatchObject({ code: 'compte_introuvable' });
    tenant!.status = 'suspended';
    await expect(joindre()).rejects.toMatchObject({ code: 'tenant_suspendu' });
    tenant = null;
    await expect(joindre()).rejects.toMatchObject({ code: 'tenant_introuvable' });
    expect(membres).toEqual([]);
  });
  it('le propriétaire n\'a pas besoin de ligne', async () => {
    expect(await joindre({ hubUserId: 'u-prop' })).toEqual({ cree: false, role: 'owner' });
    expect(membres).toEqual([]);
  });
});

describe('un membre retiré ne revient pas tout seul', () => {
  const RETRAIT = new Date('2026-11-20');
  beforeEach(async () => { await joindre(); membres[0].deletedAt = RETRAIT; });
  it('ni par une reprise, ni par une invitation d\'avant son retrait ou sans date', async () => {
    await expect(joindre({ origine: 'reprise' })).rejects.toMatchObject({ code: 'retire' });
    for (const emiseLe of [undefined, new Date('2026-11-19'), RETRAIT]) await expect(joindre({ emiseLe })).rejects.toMatchObject({ code: 'retire' });
    expect(membres[0].deletedAt).toBe(RETRAIT);
  });
  it('par une invitation neuve ou un opérateur, oui', async () => {
    expect((await joindre({ emiseLe: new Date('2026-11-21') })).cree).toBe(true);
    membres[0].deletedAt = RETRAIT;
    expect((await joindre({ origine: 'operateur' })).cree).toBe(true);
    expect(membres[0].deletedAt).toBeNull();
  });
});

/** Des apps qui tiennent leur liste de membres. */
function apps(etat: Record<string, string[]>, o: { sourd?: string; refuse?: string; muet?: string } = {}) {
  const posts: { app: string; chemin: string; corps: L }[] = [];
  const f = vi.fn(async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    const app = url.hostname.split('.')[0];
    if ((init.method ?? 'GET') === 'GET') {
      if (o.muet === app) return new Response('', { status: 500 });
      const email = url.searchParams.get('email')!;
      const ws = { notifuse: { workspace_id: 'esp' }, prospection: { workspace_id: 'wp', tenant_id: 'tp', hub_tenant_id: 'T' }, crm: { workspace_id: 'w-crm' }, academy: { workspace_id: 'wa', hub_tenant_id: 'T' }, analytics: { workspace_id: '9', hub_tenant_id: 'T' } }[app];
      // Un autre espace de la même personne, dans un autre tenant : jamais touché.
      const autre = { workspace_id: 'ailleurs', tenant_id: 'tz', hub_tenant_id: 'T-autre' };
      return Response.json({ found: true, workspaces: [...((etat[app] ?? []).includes(email) ? [ws] : []), autre] });
    }
    const corps = JSON.parse(String(init.body));
    posts.push({ app, chemin: url.pathname, corps });
    if (o.refuse === app) return new Response('', { status: 500 });
    if (o.sourd !== app && url.pathname.endsWith('/remove-member')) etat[app] = (etat[app] ?? []).filter((e) => e !== corps.email);
    return Response.json({ removed: true });
  });
  return { f: f as unknown as typeof fetch, posts };
}
const retirerM = (f: typeof fetch, liste = ['notifuse', 'prospection', 'crm']) => retirer(db, { tenantId: 'T', hubUserId: 'u-m', acteur: 'test' }, { fetchImpl: f, apps: liste as never });

describe('retirer', () => {
  beforeEach(async () => { await joindre(); audits = []; });

  it('coupe au Hub, retire de chaque app par SON identifiant, relit, et n\'approche pas l\'autre tenant', async () => {
    const a = apps({ notifuse: ['m@x.fr'], prospection: ['m@x.fr'], crm: ['m@x.fr'] });
    const r = await retirerM(a.f);
    expect(r).toMatchObject({ deja: false, complet: true });
    expect(r.apps.map((x) => x.etat)).toEqual(['retire', 'retire', 'retire']);
    expect(a.posts.map((p) => p.chemin).sort()).toEqual(['/api/tenants/T/remove-member', '/api/tenants/esp/remove-member', '/api/tenants/tp/remove-member']);
    expect(a.posts[0].corps).toMatchObject({ user_email: 'm@x.fr', email: 'm@x.fr', hub_user_id: 'u-m' });
    expect(membres[0].deletedAt).toBeInstanceOf(Date);
    expect(audits[0]).toMatchObject({ action: 'membre.retire', targetId: 'T' });
  });

  it('une app qui dit oui et garde le membre : échec dit, jamais « retiré »', async () => {
    const r = await retirerM(apps({ crm: ['m@x.fr'] }, { sourd: 'crm' }).f);
    expect(r.complet).toBe(false);
    expect(r.apps.find((x) => x.app === 'crm')).toMatchObject({ etat: 'echec', detail: expect.stringContaining('encore') });
    expect(membres[0].deletedAt, 'coupé au Hub quoi qu\'il en soit').toBeInstanceOf(Date);
  });

  it('une app en panne, muette, ou sans route : dite, les autres sont coupées', async () => {
    const r = await retirerM(apps({ notifuse: ['m@x.fr'], prospection: ['m@x.fr'], analytics: ['m@x.fr'], academy: ['m@x.fr'] }, { refuse: 'prospection', muet: 'notifuse' }).f, ['notifuse', 'prospection', 'crm', 'analytics', 'academy']);
    expect(r.apps.map((x) => [x.app, x.etat])).toEqual([['notifuse', 'echec'], ['prospection', 'echec'], ['crm', 'absent'], ['analytics', 'non_gere'], ['academy', 'non_gere']]);
    expect(r.complet).toBe(false);
  });

  it('rejoué : les apps en retard suivent, le Hub dit déjà', async () => {
    const etat = { crm: ['m@x.fr'] };
    await retirerM(apps(etat, { refuse: 'crm' }).f);
    expect(await retirerM(apps(etat).f)).toMatchObject({ deja: true, complet: true });
  });

  it('ses invitations en attente vers ce tenant expirent, celles d\'un autre tenant non', async () => {
    const plusTard = new Date(Date.now() + 1e9);
    const i = (id: string, targetApp: string, targetWorkspaceId: string, o: L = {}) => ({ id, targetApp, targetWorkspaceId, inviteeEmail: 'M@x.fr', acceptedAt: null, expiresAt: plusTard, ...o });
    invitations = [i('note', 'notifuse', 'esp'), i('relu', 'prospection', 'wp'), i('autre', 'prospection', 'ailleurs'), i('autrui', 'notifuse', 'esp', { inviteeEmail: 'z@x.fr' }), i('faite', 'notifuse', 'esp', { acceptedAt: new Date() })];
    await retirerM(apps({ prospection: ['m@x.fr', 'prop@x.fr'] }).f);
    expect(invitations.filter((x) => x.expiresAt !== plusTard).map((x) => x.id)).toEqual(['note', 'relu']);
    expect(audits[0].payload.invitations).toBe(2);
  });

  it('jamais le propriétaire ; un inconnu de partout : pas membre', async () => {
    await expect(retirer(db, { tenantId: 'T', hubUserId: 'u-prop', acteur: 'x' })).rejects.toMatchObject({ code: 'proprietaire' });
    membres = [];
    await expect(retirerM(apps({}).f)).rejects.toMatchObject({ code: 'pas_membre' });
  });
});

describe('suspension', () => {
  const basculer = (suspendre: boolean, f: typeof fetch) => basculerSuspension(db, { tenantId: 'T', suspendre, acteur: 'test' }, { fetchImpl: f, apps: ['notifuse', 'prospection', 'academy', 'crm'] as never });
  it('au Hub d\'abord, puis les apps qui savent ; celle qui ne sait pas est dite ; reprise symétrique', async () => {
    const etat = { notifuse: ['prop@x.fr'], prospection: ['prop@x.fr'], academy: ['prop@x.fr'], crm: ['prop@x.fr'] };
    const a = apps(etat);
    const r = await basculer(true, a.f);
    expect(tenant!.status).toBe('suspended');
    expect(r.apps.map((x) => x.etat)).toEqual(['suspendu', 'suspendu', 'suspendu', 'non_gere']);
    expect(r.complet).toBe(false);
    expect(r.avis, 'celui qui suspend lit ce qui ne l\'est pas').toContain('crm (aucune route de suspension');
    expect(a.posts.map((p) => [p.app, p.chemin, p.corps.tenant_id])).toEqual(expect.arrayContaining([['notifuse', '/api/tenants/suspend', 'esp'], ['prospection', '/api/tenants/suspend', 'tp'], ['academy', '/api/tenants/suspend', 'T']]));
    expect(audits[0]).toMatchObject({ action: 'tenant.suspendu' });
    const b = apps(etat);
    expect((await basculer(false, b.f)).apps[0].etat).toBe('repris');
    expect(tenant!.status).toBe('active');
    expect(b.posts.every((p) => p.chemin === '/api/tenants/resume')).toBe(true);
  });
  it('une app qui refuse : échec dit, le Hub reste suspendu', async () => {
    const r = await basculer(true, apps({ notifuse: ['prop@x.fr'] }, { refuse: 'notifuse' }).f);
    expect(r.apps[0]).toMatchObject({ etat: 'echec', detail: 'http_500' });
    expect(tenant!.status).toBe('suspended');
  });
});

it('nonCoupees : null quand tout est coupé, sinon chaque app et sa raison', () => {
  expect(nonCoupees([{ app: 'crm', etat: 'retire' }, { app: 'academy', etat: 'absent' }])).toBeNull();
  expect(nonCoupees([{ app: 'analytics', etat: 'non_gere', detail: 'aucune route' }, { app: 'crm', etat: 'echec', detail: 'http_500' }])).toMatch(/analytics \(aucune route\), crm \(http_500\)/);
});

it('le Hub ne resynchronise jamais un membre : aucun appel à sync-member, attach-member seulement pour une invitation acceptée', () => {
  const sources = ['app', 'lib', 'utils'].flatMap((d) => parcourir(d)).filter((f) => /\.tsx?$/.test(f));
  const appelle = (motif: RegExp) => sources.filter((f) => motif.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))).map((f) => f.replace(/^.*\/(lib|app|utils)\//, '$1/'));
  expect(appelle(/remove-member/), 'contrôle : le relevé voit un appel').toContain('lib/tenants/membres.ts');
  expect(appelle(/sync-member/)).toEqual([]);
  expect(appelle(/attach-member/)).toEqual(['lib/invitations/attach-downstream.ts']);
});

it('un seul écrivain de tenant_members dans tout le code', () => {
  const ecrit = /tenantMember\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)|(INSERT INTO|UPDATE|DELETE FROM)\s+("?hub_app"?\.)?"?tenant_members/i;
  const fichiers = ['app', 'lib', 'utils', 'scripts'].flatMap((d) => parcourir(d)).filter((f) => /\.(ts|tsx|mjs|sh|py)$/.test(f));
  expect(fichiers.length).toBeGreaterThan(100);
  expect(fichiers.filter((f) => ecrit.test(readFileSync(f, 'utf8'))).map((f) => f.replace(/^.*\/(lib|app|utils|scripts)\//, '$1/'))).toEqual(['lib/tenants/membres.ts', 'scripts/e2e/mega-purge.sh' /* purge des comptes de test */]);
});
