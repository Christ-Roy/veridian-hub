// @vitest-environment node
/** L'administrateur de plateforme posé ADMIN chez Mail et Academy, jamais propriétaire, jamais remis après un retrait du client (VER-263, §5.23). */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { designationEnEchec, designerAdminsPlateforme } from '@/lib/apps/admins-plateforme';
import { exigeV1, exigeV2 } from '../hmac/aide-v2';

const ROBERT = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const CLIENT = '11111111-2222-4333-8444-555555555555';
type Appel = { url: string; methode: string; corps: Record<string, unknown> | null; signe: boolean };
let appels: Appel[];
let rep: (a: Appel) => [number, unknown];
const fetchImpl = (async (url: string, i: RequestInit) => {
  const h = i.headers as Record<string, string>;
  const brut = (i.body as string) ?? '';
  const a: Appel = { url, methode: i.method!, corps: brut ? JSON.parse(brut) : null, signe: h['X-Veridian-Hub-Signature'] === createHmac('sha256', 's3cret').update(`${h['X-Veridian-Timestamp']}.${brut}`).digest('hex') };
  appels.push(a);
  const [status, json] = rep(a);
  return new Response(JSON.stringify(json), { status });
}) as unknown as typeof fetch;
const membres = (...l: object[]) => [200, { workspace_id: 'ws', members: l }] as [number, unknown];
let t: { userId: string; notifuseWorkspaceSlug: string | null } | null;
const db = { tenant: { findFirst: async () => t }, user: { findMany: async () => [{ supabaseUserId: ROBERT, email: 'robert@v' }] } } as never;
const tout = () => designerAdminsPlateforme(db, 'T', { fetchImpl, acteur: ROBERT, raison: 'appel du client' });
/** Les désignations chez Mail seulement (Academy, sans URL ici, se dit « non branchée » à part). */
const jouer = async () => { const r = await tout(); return r && r.filter((x) => x.app === 'notifuse'); };
const posts = () => appels.filter((a) => a.methode === 'POST').map((a) => a.url.replace('https://mail', ''));

beforeEach(() => {
  appels = [];
  t = { userId: CLIENT, notifuseWorkspaceSlug: 'ws' };
  vi.stubEnv('PLATFORM_ADMINS', ROBERT);
  vi.stubEnv('NOTIFUSE_API_URL', 'https://mail');
  vi.stubEnv('NOTIFUSE_HUB_API_SECRET', 's3cret');
});
afterEach(() => vi.unstubAllEnvs());

describe('designerAdminsPlateforme', () => {
  it('membre : désigné admin, relu ; chaque appel signé ; jamais propriétaire, jamais remis de force', async () => {
    let n = 0;
    rep = (a) => (a.methode === 'GET' ? (n++ === 0 ? membres({ hub_user_id: CLIENT, role: 'owner' }, { hub_user_id: ROBERT, role: 'member' }) : membres({ hub_user_id: ROBERT, role: 'admin', admin_granted: true })) : [200, { role_after: 'admin' }]);
    expect(await jouer()).toEqual([{ app: 'notifuse', hubUserId: ROBERT, etat: 'admin' }]);
    expect(posts()).toEqual(['/api/hub/workspace-admins']);
    expect(appels.every((a) => a.signe)).toBe(true);
    expect(appels[1].corps).toEqual({ workspace_id: 'ws', hub_user_id: ROBERT, action: 'grant', actor_hub_user_id: ROBERT, reason: 'appel du client', reinstate: false });
  });
  it('pas membre : le Hub n\'ajoute personne (aucun sync-member, aucun attach-member), il le dit', async () => {
    rep = () => membres({ hub_user_id: CLIENT, role: 'owner' });
    expect((await jouer())![0].etat).toBe('pas_membre');
    expect(posts()).toEqual([]);
  });
  it('déjà admin : rejoué sans rien changer d\'autre', async () => {
    rep = (a) => (a.methode === 'GET' ? membres({ hub_user_id: ROBERT, role: 'admin' }) : [200, {}]);
    expect((await jouer())![0].etat).toBe('admin');
    expect(posts()).toEqual(['/api/hub/workspace-admins']);
  });
  it('propriétaire : rien n\'est envoyé, il le reste', async () => {
    rep = () => membres({ hub_user_id: ROBERT, role: 'owner' });
    expect((await jouer())![0].etat).toBe('proprietaire');
    expect(posts()).toEqual([]);
  });
  it('retiré par le client : jamais remis, à la lecture comme à la réponse', async () => {
    rep = () => membres({ hub_user_id: ROBERT, role: 'member', admin_withdrawn: true });
    expect((await jouer())![0].etat).toBe('retire_par_le_client');
    expect(posts()).toEqual([]);
    rep = (a) => (a.methode === 'GET' ? membres({ hub_user_id: ROBERT, role: 'member' }) : [409, { error: 'admin_withdrawn' }]);
    expect((await jouer())![0].etat).toBe('retire_par_le_client');
    expect(appels.some((a) => a.corps?.reinstate === true)).toBe(false);
  });
  it('« admin » ne se dit que relu : l\'app répond 200 mais ne l\'a pas fait', async () => {
    rep = (a) => (a.methode === 'GET' ? membres({ hub_user_id: ROBERT, role: 'member' }) : [200, {}]);
    const r = (await jouer())!;
    expect(r[0]).toMatchObject({ etat: 'echec', detail: 'relu : member' });
    expect(designationEnEchec(r)).toBe(true);
  });
  it.each([
    [[500, {}], 'echec'],
    [[404, { error: 'tenant_not_found' }], 'sans_espace'],
  ] as const)('relecture %j : %s', async (lu, etat) => {
    rep = () => lu as [number, unknown];
    expect((await jouer())![0].etat).toBe(etat);
  });
  it('sans compte Mail relié : dit, rien de créé', async () => {
    rep = (a) => (a.methode === 'GET' ? membres({ hub_user_id: ROBERT, role: 'member' }) : [404, { error: 'user_not_in_app' }]);
    expect((await jouer())![0].etat).toBe('pas_de_compte');
  });
  it('le propriétaire est l\'administrateur lui-même : rien ; organisation sans Mail : sans_espace ; inconnue : null', async () => {
    rep = () => membres();
    t = { userId: ROBERT, notifuseWorkspaceSlug: 'ws' };
    expect(await jouer()).toEqual([]);
    t = { userId: CLIENT, notifuseWorkspaceSlug: null };
    expect((await jouer())![0].etat).toBe('sans_espace');
    t = null;
    expect(await jouer()).toBeNull();
    expect(appels).toEqual([]);
  });
  it('Mail non branché : dit, aucun appel', async () => {
    vi.stubEnv('NOTIFUSE_HUB_API_SECRET', '');
    rep = () => membres();
    expect((await jouer())![0].etat).toBe('non_branchee');
  });
});

describe('designerAdminsPlateforme chez Academy (a244873, 27/11)', () => {
  beforeEach(() => {
    vi.stubEnv('NOTIFUSE_HUB_API_SECRET', '');
    vi.stubEnv('ACADEMY_API_URL', 'https://academy');
    vi.stubEnv('ACADEMY_HUB_API_SECRET', 's3cret');
  });
  const academy = async () => (await tout())!.filter((x) => x.app === 'academy');
  it('membre : désigné admin dans l\'espace du TENANT Hub (workspace_id = tenant), relu, signé', async () => {
    let n = 0;
    rep = (a) => (a.methode === 'GET' ? (n++ === 0 ? membres({ hub_user_id: CLIENT, role: 'owner' }, { hub_user_id: ROBERT, role: 'member' }) : membres({ hub_user_id: ROBERT, role: 'admin' })) : [200, {}]);
    expect(await academy()).toEqual([{ app: 'academy', hubUserId: ROBERT, etat: 'admin' }]);
    const vers = appels.filter((a) => a.url.startsWith('https://academy'));
    expect(vers.map((a) => [a.methode, a.url])).toEqual([
      ['GET', 'https://academy/api/hub/workspace-admins?workspace_id=T'],
      ['POST', 'https://academy/api/hub/workspace-admins'],
      ['GET', 'https://academy/api/hub/workspace-admins?workspace_id=T'],
    ]);
    expect(vers[1].corps).toMatchObject({ workspace_id: 'T', action: 'grant', reinstate: false });
    expect(vers.every((a) => a.signe)).toBe(true);
  });
  it('organisation sans espace Academy (404 tenant_not_found) : sans_espace, rien d\'envoyé', async () => {
    rep = () => [404, { error: 'tenant_not_found' }];
    expect((await academy())[0]).toMatchObject({ etat: 'sans_espace', detail: 'tenant_not_found' });
    expect(appels.filter((a) => a.methode === 'POST')).toEqual([]);
  });
  it('retiré par le client chez Academy : jamais remis, le nom de l\'app dit où', async () => {
    rep = (a) => (a.methode === 'GET' ? membres({ hub_user_id: ROBERT, role: 'member' }) : [409, { error: 'admin_withdrawn' }]);
    expect((await academy())[0].etat).toBe('retire_par_le_client');
    rep = () => membres({ hub_user_id: CLIENT, role: 'owner' });
    expect((await academy())[0]).toMatchObject({ etat: 'pas_membre', detail: expect.stringContaining('espace Academy') });
  });
});

describe('designerAdminsPlateforme, version de signature', () => {
  const capter = async () => {
    const vus: { url: string; methode: string; brut: string; h: Record<string, string> }[] = [];
    const f = (async (url: string, i: RequestInit) => {
      vus.push({ url, methode: i.method!, brut: (i.body as string) ?? '', h: i.headers as Record<string, string> });
      return new Response(JSON.stringify(i.method === 'GET' ? { workspace_id: 'ws', members: [{ hub_user_id: ROBERT, role: 'member' }] } : {}), { status: 200 });
    }) as unknown as typeof fetch;
    await designerAdminsPlateforme(db, 'T', { fetchImpl: f, acteur: ROBERT, raison: 'appel du client' });
    return vus;
  };
  it('HMAC_V2_APPS=notifuse : le GET et le POST partent en v2, chacun lié à sa méthode et à son chemin', async () => {
    vi.stubEnv('HMAC_V2_APPS', 'notifuse');
    const vus = await capter();
    expect(vus.map((v) => v.methode)).toContain('GET');
    expect(vus.map((v) => v.methode)).toContain('POST');
    for (const v of vus) exigeV2(v.h, 's3cret', v.methode, v.url, v.brut);
  });
  it('variable absente : v1', async () => {
    const vus = await capter();
    expect(vus.length).toBeGreaterThan(0);
    for (const v of vus) exigeV1(v.h, 's3cret', v.brut);
  });
});
