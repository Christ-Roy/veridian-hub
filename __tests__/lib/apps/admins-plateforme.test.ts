// @vitest-environment node
/** L'administrateur de plateforme posé ADMIN chez Mail, jamais propriétaire, jamais remis après un retrait du client (VER-263, §5.23). */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { designationEnEchec, designerAdminsPlateforme } from '@/lib/apps/admins-plateforme';

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
const jouer = () => designerAdminsPlateforme(db, 'T', { fetchImpl, acteur: ROBERT, raison: 'appel du client' });
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
  it('absent : membre, puis admin, relu ; chaque appel signé, jamais propriétaire', async () => {
    let n = 0;
    rep = (a) => (a.methode === 'GET' ? (n++ === 0 ? membres({ hub_user_id: CLIENT, role: 'owner' }) : membres({ hub_user_id: ROBERT, role: 'admin', admin_granted: true })) : [200, { role_after: 'admin' }]);
    expect(await jouer()).toEqual([{ app: 'notifuse', hubUserId: ROBERT, etat: 'admin' }]);
    expect(posts()).toEqual(['/api/tenants/ws/sync-member', '/api/hub/workspace-admins']);
    expect(appels.every((a) => a.signe)).toBe(true);
    expect(appels[1].corps).toMatchObject({ hub_user_id: ROBERT, role: 'member', email_proven: true });
    expect(appels[2].corps).toEqual({ workspace_id: 'ws', hub_user_id: ROBERT, action: 'grant', actor_hub_user_id: ROBERT, reason: 'appel du client', reinstate: false });
    expect(JSON.stringify(appels.map((a) => a.corps))).not.toMatch(/owner|reinstate":true|transfer/);
  });
  it('déjà membre : aucun « member » poussé (il rétrograderait un propriétaire)', async () => {
    rep = (a) => (a.methode === 'GET' ? membres({ hub_user_id: ROBERT, role: 'admin' }) : [200, {}]);
    await jouer();
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
    rep = (a) => (a.methode === 'GET' ? membres() : [409, { error: 'admin_withdrawn' }]);
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
    rep = (a) => (a.methode === 'GET' ? membres() : [404, { error: 'user_not_in_app' }]);
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
