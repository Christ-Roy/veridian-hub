// @vitest-environment node
/** Appartenance : un seul écrivain, un retrait relu, une suspension dite app par app. */
import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const org = vi.hoisted(() => ({ suivre: vi.fn(async (..._a: unknown[]) => []) }));
vi.mock('@/lib/organisations/emission', () => ({ suivreOrganisation: org.suivre }));

import { basculerSuspension, avisCles, nonCoupees, oublierCompte, rejoindre, retirer, retirerDeLApp, type DbMembres } from '@/lib/tenants/membres';

import { parcourir } from '../../contrat/source';

type L = Record<string, any>;
let tenant: L | null;
let users: L[];
let membres: L[];
let audits: L[];
let invitations: L[];
let revoques: L[];
let coupees: L[];
let preinscrites: L[];
let secondaires: L[] = [];
const trouve = (w: L) => membres.find((m) => m.tenantId === w.tenantId_userId.tenantId && m.userId === w.tenantId_userId.userId) ?? null;
const db = {
  tenant: { findFirst: async ({ where }: L) => (tenant && tenant.id === where.id ? tenant : null), update: async ({ data }: L) => Object.assign(tenant!, data) },
  user: { findFirst: async ({ where }: L) => users.find((u) => u.supabaseUserId === where.supabaseUserId) ?? null },
  tenantMember: {
    findUnique: async ({ where }: L) => { const l = trouve(where); return l && { ...l }; },
    upsert: async ({ where, create, update }: L) => { const l = trouve(where); if (l) Object.assign(l, update); else membres.push({ deletedAt: null, ...create }); },
    update: async ({ where, data }: L) => Object.assign(trouve(where)!, data),
  },
  delegationGrant: { updateMany: async ({ where }: L) => { revoques.push(where); return { count: 1 }; } },
  integrationPaire: { updateMany: async ({ where, data }: L) => { coupees.push([where, data]); return { count: 1 }; } },
  userEmail: { findMany: async ({ where }: L) => secondaires.filter((x) => x.hub === where.user.supabaseUserId && !x.detacheeLe) },
  tenantPreinscription: { updateMany: async ({ where, data }: L) => { preinscrites.push([where, data]); return { count: 1 }; } },
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
  revoques = [];
  coupees = [];
  preinscrites = [];
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
  it('chaque entrée et chaque changement de rôle date le rôle : la version que l\'app compare avance', async () => {
    await joindre();
    const un = membres[0].roleLe as Date;
    expect(un).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 3));
    await joindre({ origine: 'operateur', role: 'admin' });
    expect(membres[0].roleLe.getTime()).toBeGreaterThan(un.getTime());
    const deux = membres[0].roleLe;
    await joindre({ origine: 'operateur', role: 'admin' });
    expect(membres[0].roleLe, 'rien ne change : la version non plus').toBe(deux);
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
function apps(etat: Record<string, string[]>, o: { sourd?: string; refuse?: string; dit?: Record<string, [number, string]>; sansLien?: string; muet?: string; cles?: Record<string, object> } = {}) {
  const posts: { app: string; chemin: string; corps: L }[] = [];
  const f = vi.fn(async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    const app = url.hostname.split('.')[0];
    if ((init.method ?? 'GET') === 'GET') {
      if (o.muet === app) return new Response('', { status: 500 });
      const email = url.searchParams.get('email')!;
      // Une app qui lit hub_user_id ne voit pas un compte sans lien.
      if (o.sansLien === app && url.searchParams.has('hub_user_id')) return Response.json({ found: false });
      const ws = { notifuse: { workspace_id: 'esp' }, prospection: { workspace_id: 'wp', tenant_id: 'tp', hub_tenant_id: 'T' }, crm: { workspace_id: 'w-crm' }, academy: { workspace_id: 'wa', hub_tenant_id: 'T' }, analytics: { workspace_id: '9', hub_tenant_id: 'T' } }[app];
      // Un autre espace de la même personne, dans un autre tenant : jamais touché.
      const autre = { workspace_id: 'ailleurs', tenant_id: 'tz', hub_tenant_id: 'T-autre' };
      return Response.json({ found: true, workspaces: [...((etat[app] ?? []).includes(email) ? [ws] : []), autre] });
    }
    const corps = JSON.parse(String(init.body));
    posts.push({ app, chemin: url.pathname, corps });
    if (o.refuse === app) return new Response('', { status: 500 });
    if (o.dit?.[app]) return Response.json({ error: o.dit[app][1] }, { status: o.dit[app][0] });
    if (o.sourd !== app && url.pathname.endsWith('/remove-member')) etat[app] = (etat[app] ?? []).filter((e) => e !== corps.email);
    return Response.json({ removed: true, ...(o.cles?.[app] ?? {}) });
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

  it('un compte sans lien avec le Hub ne se dit jamais « absent » : il y est encore, et rien n\'est envoyé par l\'adresse', async () => {
    const a = apps({ notifuse: ['m@x.fr'] }, { sansLien: 'notifuse' });
    const r = await retirerM(a.f, ['notifuse', 'crm']);
    expect(r.apps).toEqual([{ app: 'notifuse', etat: 'echec', detail: expect.stringContaining('sans lien avec le Hub') }, { app: 'crm', etat: 'absent' }]);
    expect([r.complet, a.posts]).toEqual([false, []]);
  });

  it('les clés API restées actives sont dites app par app, jamais tues ; une clé n\'est pas un échec', async () => {
    const a = apps({ academy: ['m@x.fr'], notifuse: ['m@x.fr'], prospection: ['m@x.fr'], crm: ['m@x.fr'] }, { cles: {
      academy: { active_api_keys_created_by_member: 2 },
      notifuse: { active_api_keys: 3, api_keys_url: 'https://notifuse.app.veridian.site/console/cles' },
      prospection: { active_api_keys: 0 },
      crm: { active_api_keys: 1, api_keys_url: 'https://pirate.test/vol' },
    } });
    const r = await retirerM(a.f, ['notifuse', 'prospection', 'crm', 'academy']);
    expect(r.complet).toBe(true);
    expect(r.apps.map((x) => x.cles)).toEqual([
      { actives: 3, par: 'espace', url: 'https://notifuse.app.veridian.site/console/cles' }, { actives: 0, par: 'espace' },
      { actives: 1, par: 'espace' }, { actives: 2, par: 'personne' },
    ]);
    expect(r.avis).toMatch(/notifuse 3 \(https:\/\/notifuse\.app\.veridian\.site\/console\/cles\), crm 1, academy 2 créée\(s\) par cette personne\.$/);
    expect(a.posts.find((p) => p.app === 'academy')?.chemin).toBe('/api/tenants/T/remove-member');
  });

  it('ses poignées de délégation dans CE tenant meurent', async () => {
    await retirerM(apps({}).f, ['notifuse']).catch(() => undefined);
    expect(revoques).toEqual([{ hubUserId: 'u-m', tenantId: 'T', revoqueLe: null }]);
  });

  it('une app qui dit oui et garde le membre : échec dit, jamais « retiré »', async () => {
    const r = await retirerM(apps({ crm: ['m@x.fr'] }, { sourd: 'crm' }).f);
    expect(r.complet).toBe(false);
    expect(r.apps.find((x) => x.app === 'crm')).toMatchObject({ etat: 'echec', detail: expect.stringContaining('encore') });
    expect(membres[0].deletedAt, 'coupé au Hub quoi qu\'il en soit').toBeInstanceOf(Date);
  });

  it('une app en panne, muette, ou sans route : dite, les autres sont coupées', async () => {
    const r = await retirerM(apps({ notifuse: ['m@x.fr'], prospection: ['m@x.fr'], analytics: ['m@x.fr'], academy: ['m@x.fr'] }, { refuse: 'prospection', muet: 'notifuse' }).f, ['notifuse', 'prospection', 'crm', 'analytics', 'academy']);
    expect(r.apps.map((x) => [x.app, x.etat])).toEqual([['notifuse', 'echec'], ['prospection', 'echec'], ['crm', 'absent'], ['analytics', 'non_gere'], ['academy', 'retire']]);
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
  const basculer = (suspendre: boolean, f: typeof fetch) => basculerSuspension(db, { tenantId: 'T', suspendre, acteur: 'test' }, { fetchImpl: f, apps: ['notifuse', 'prospection', 'academy', 'crm', 'analytics'] as never });
  beforeEach(() => org.suivre.mockClear());
  it('au Hub d\'abord, puis les apps qui savent ; celle qui ne sait pas est dite ; reprise symétrique, l\'organisation repart', async () => {
    const etat = { notifuse: ['prop@x.fr'], prospection: ['prop@x.fr'], academy: ['prop@x.fr'], crm: ['prop@x.fr'], analytics: ['prop@x.fr'] };
    const a = apps(etat);
    const r = await basculer(true, a.f);
    expect(tenant!.status).toBe('suspended');
    expect(r.apps.map((x) => x.etat)).toEqual(['suspendu', 'suspendu', 'suspendu', 'suspendu', 'non_gere']);
    expect(r.complet).toBe(false);
    expect(r.avis, 'celui qui suspend lit ce qui ne l\'est pas').toContain('analytics (aucune route de suspension');
    expect(a.posts.map((p) => [p.app, p.chemin, p.corps.tenant_id])).toEqual(expect.arrayContaining([['notifuse', '/api/tenants/suspend', 'esp'], ['prospection', '/api/tenants/suspend', 'tp'], ['academy', '/api/tenants/suspend', 'T'], ['crm', '/api/tenants/suspend', 'T']]));
    expect(org.suivre, 'suspendue : rien à émettre').not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({ action: 'tenant.suspendu' });
    expect(revoques, 'poignées du tenant').toEqual([{ tenantId: 'T', revoqueLe: null }]);
    expect(coupees[0][1], 'consentements retirés').toMatchObject({ etat: 'eteinte', consentiLe: null });
    const b = apps(etat);
    expect((await basculer(false, b.f)).apps.map((x) => x.etat)).toEqual(['repris', 'repris', 'repris', 'repris', 'non_gere']);
    expect(org.suivre.mock.calls.map((c) => c[1]), 'ce qu\'un 423 avait retenu').toEqual(['T']);
    expect(tenant!.status).toBe('active');
    expect(b.posts.every((p) => p.chemin === '/api/tenants/resume')).toBe(true);
  });
  it('une app qui cache l\'espace suspendu est quand même reprise, par la cible notée ; rien ne reste noté ensuite', async () => {
    const etat: Record<string, string[]> = { notifuse: ['prop@x.fr'], prospection: ['prop@x.fr'] };
    await basculer(true, apps(etat).f);
    expect(tenant!.metadata).toMatchObject({ crm: { workspace_id: 'w-crm' }, hub_suspension: { cibles: { notifuse: ['esp'], prospection: ['tp'] } } });
    etat.prospection = []; // Prospection ne montre plus un tenant suspendu.
    const b = apps(etat);
    expect((await basculer(false, b.f)).apps.slice(0, 2).map((x) => x.etat)).toEqual(['repris', 'repris']);
    expect(b.posts.map((p) => p.corps.tenant_id).sort()).toEqual(['esp', 'tp']);
    expect(tenant!.metadata).toEqual({ crm: { workspace_id: 'w-crm' } });
  });

  it('reprise ratée chez une app : sa cible reste notée, un rejeu la vise encore', async () => {
    const etat: Record<string, string[]> = { prospection: ['prop@x.fr'] };
    await basculer(true, apps(etat).f);
    etat.prospection = [];
    expect((await basculer(false, apps(etat, { refuse: 'prospection' }).f)).apps[1].etat).toBe('echec');
    expect((await basculer(false, apps(etat).f)).apps[1].etat).toBe('repris');
  });

  it('retirer un membre d\'un espace suspendu que l\'app cache : envoyé, mais jamais dit « retiré » ni « absent »', async () => {
    await joindre();
    const etat: Record<string, string[]> = { prospection: ['prop@x.fr', 'm@x.fr'] };
    await basculer(true, apps(etat).f);
    const a = apps({});
    const r = await retirerM(a.f, ['prospection']);
    expect(r.apps[0]).toMatchObject({ etat: 'echec', detail: expect.stringContaining('pas relu') });
    expect(a.posts.map((p) => p.chemin)).toEqual(['/api/tenants/tp/remove-member']);
  });

  it('propriétaire sans lien dans l\'app : son espace est fermé quand même, c\'est lui qu\'on vise', async () => {
    const a = apps({ notifuse: ['prop@x.fr'] }, { sansLien: 'notifuse' });
    expect((await basculer(true, a.f)).apps[0]).toEqual({ app: 'notifuse', etat: 'suspendu' });
    expect(a.posts.map((p) => p.corps.tenant_id)).toEqual(['esp']);
  });
  it('le CRM dit « pas suspendu par le Hub » : échec DIT, jamais avalé, et plus visé au prochain rejeu', async () => {
    const etat: Record<string, string[]> = { crm: ['prop@x.fr'] };
    await basculer(true, apps(etat).f);
    const r = await basculer(false, apps(etat, { dit: { crm: [409, 'not_suspended_by_hub'] } }).f);
    expect(r.apps[3]).toEqual({ app: 'crm', etat: 'echec', detail: 'fermé par un autre chemin que le Hub : pas repris, à rouvrir dans l\'app (not_suspended_by_hub, http_409)' });
    expect([r.complet, r.avis]).toEqual([false, expect.stringContaining('not_suspended_by_hub')]);
    expect(tenant!.metadata).toEqual({ crm: { workspace_id: 'w-crm' } });
  });
  it('un code inconnu est rendu tel quel, un texte libre non ; espace disparu : rien à fermer', async () => {
    const etat: Record<string, string[]> = { crm: ['prop@x.fr'] };
    expect((await basculer(true, apps(etat, { dit: { crm: [409, 'workspace_not_active'] } }).f)).apps[3].detail).toMatch(/en cours de création.*workspace_not_active, http_409/);
    expect((await basculer(true, apps(etat, { dit: { crm: [418, 'theiere_pleine'] } }).f)).apps[3].detail).toBe('theiere_pleine (theiere_pleine, http_418)');
    expect((await basculer(true, apps(etat, { dit: { crm: [400, 'Un texte <b>libre</b>'] } }).f)).apps[3].detail).toBe('http_400');
    expect((await basculer(true, apps(etat, { dit: { crm: [410, 'workspace_gone'] } }).f)).apps[3].etat).toBe('suspendu');
  });

  it('une app qui refuse : échec dit, le Hub reste suspendu', async () => {
    const r = await basculer(true, apps({ notifuse: ['prop@x.fr'] }, { refuse: 'notifuse' }).f);
    expect(r.apps[0]).toMatchObject({ etat: 'echec', detail: 'http_500' });
    expect(tenant!.status).toBe('suspended');
  });
});

it('oublierCompte : appartenances, invitations envoyées et reçues ; celles des autres restent', async () => {
  const jeu: L[] = [];
  const d = { tenantIdp: { deleteMany: async (x: L) => { jeu.push(['idp', x.where]); return { count: 0 }; } }, tenantPreinscription: { deleteMany: async (x: L) => { jeu.push(['preinscriptions', x.where]); return { count: 0 }; } }, tenantMember: { deleteMany: async (x: L) => { jeu.push(['membres', x.where]); return { count: 1 }; } }, crossAppInvitation: { updateMany: async (x: L) => { jeu.push(['acceptees', x]); return { count: 0 }; }, deleteMany: async (x: L) => { jeu.push(['invitations', x.where]); return { count: 2 }; } } } as never;
  expect(await oublierCompte(d, { id: 'c', email: 'A@b.fr', hubUserId: 'u', tenants: ['T'] })).toEqual({ membres: 1, invitations: 2 });
  expect(jeu).toEqual([['membres', { userId: 'u' }], ['preinscriptions', { OR: [{ email: 'a@b.fr' }, { tenantId: { in: ['T'] } }] }], ['idp', { tenantId: { in: ['T'] } }], ['acceptees', { where: { acceptedByUserId: 'c' }, data: { acceptedByUserId: null } }], ['invitations', { OR: [{ inviterUserId: 'c' }, { inviteeEmail: { equals: 'A@b.fr', mode: 'insensitive' } }] }]]);
  expect(await oublierCompte(d, { id: 'c', email: 'a@b.fr', hubUserId: null })).toEqual({ membres: 0, invitations: 2 });
});

it('retirerDeLApp : cette app seule, relue ; l\'appartenance au Hub ne bouge pas', async () => {
  await joindre();
  const a = apps({ crm: ['m@x.fr'], notifuse: ['m@x.fr'] });
  expect(await retirerDeLApp('crm', tenant as never, 'm@x.fr', 'u-m', { fetchImpl: a.f })).toMatchObject({ app: 'crm', etat: 'retire' });
  expect(a.posts.map((p) => [p.app, p.chemin])).toEqual([['crm', '/api/tenants/T/remove-member']]);
  expect(membres[0].deletedAt ?? null).toBeNull();
  expect(await retirerDeLApp('crm', tenant as never, 'm@x.fr', 'u-m', { fetchImpl: apps({ crm: ['m@x.fr'] }, { refuse: 'crm' }).f })).toMatchObject({ etat: 'echec' });
});

it('oublierCompte : ses notes d\'accès par organisation partent aussi, et celles de ses tenants', async () => {
  const vus: L[] = [];
  const rien = { deleteMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }) };
  await oublierCompte({ tenantIdp: rien, tenantPreinscription: rien, tenantMember: rien, crossAppInvitation: rien, organisationAcces: { deleteMany: async (x: L) => { vus.push(x.where); return { count: 1 }; } } } as never, { id: 'c', email: 'a@b.fr', hubUserId: 'u', tenants: ['T'] });
  expect(vus).toEqual([{ OR: [{ hubUserId: 'u' }, { tenantId: { in: ['T'] } }] }]);
});

it('nonCoupees : null quand tout est coupé, sinon chaque app et sa raison', () => {
  expect(nonCoupees([{ app: 'crm', etat: 'retire' }, { app: 'academy', etat: 'absent' }])).toBeNull();
  expect(nonCoupees([{ app: 'analytics', etat: 'non_gere', detail: 'aucune route' }, { app: 'crm', etat: 'echec', detail: 'http_500' }])).toMatch(/analytics \(aucune route\), crm \(http_500\)/);
});

it('avisCles : une app qui ne compte pas est dite « non comptées », zéro et absent se taisent', () => {
  expect(avisCles([{ app: 'crm', etat: 'absent' }, { app: 'academy', etat: 'retire', cles: { actives: 0, par: 'espace' } }])).toBeNull();
  expect(avisCles([{ app: 'notifuse', etat: 'retire' }, { app: 'analytics', etat: 'non_gere' }])).toMatch(/notifuse non comptées, analytics non comptées/);
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

it('retirer annule la pré-inscription encore ouverte de cette adresse, dans cette organisation seule', async () => {
  membres = [{ tenantId: 'T', userId: 'u-m', role: 'member', deletedAt: null }];
  await retirer(db, { tenantId: 'T', hubUserId: 'u-m', acteur: 'op' }, { apps: [] });
  expect(preinscrites).toEqual([[{ tenantId: 'T', email: { in: ['m@x.fr'] }, consommeeLe: null, annuleeLe: null }, { annuleeLe: expect.any(Date) }]]);
  secondaires = [{ hub: 'u-m', email: 'pro@client.fr' }, { hub: 'u-m', email: 'vieille@x.fr', detacheeLe: new Date() }, { hub: 'u-prop', email: 'p@x.fr' }];
  await retirer(db, { tenantId: 'T', hubUserId: 'u-m', acteur: 'op' }, { apps: [] }).catch(() => undefined);
  secondaires = [];
  expect(preinscrites[1][0].email, 'toutes ses adresses, pas celles d\'un autre').toEqual({ in: ['m@x.fr', 'pro@client.fr'] });
});
it('une pré-inscription ne donne que member, et ne rend pas un retiré si elle date d\'avant', async () => {
  await expect(joindre({ origine: 'preinscription', role: 'admin' })).rejects.toMatchObject({ code: 'role_refuse' });
  membres = [{ tenantId: 'T', userId: 'u-m', role: 'member', deletedAt: new Date('2026-11-20') }];
  await expect(joindre({ origine: 'preinscription', emiseLe: new Date('2026-11-19') })).rejects.toMatchObject({ code: 'retire' });
  expect(await joindre({ origine: 'preinscription', emiseLe: new Date('2026-11-21') })).toMatchObject({ cree: true, role: 'member' });
});
it('une fédération ne donne que member, et ne fait JAMAIS revenir un retiré', async () => {
  await expect(joindre({ origine: 'federation', role: 'admin' })).rejects.toMatchObject({ code: 'role_refuse' });
  membres = [{ tenantId: 'T', userId: 'u-m', role: 'member', deletedAt: new Date('2026-11-20') }];
  await expect(joindre({ origine: 'federation', emiseLe: new Date() })).rejects.toMatchObject({ code: 'retire' });
});
