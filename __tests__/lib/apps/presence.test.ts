// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ decouvrir: vi.fn(), etat: vi.fn() }));
vi.mock('@/lib/notifuse/client', () => ({ NotifuseClient: class { getStatus(slug: string) { return m.etat(slug); } } }));
vi.mock('@/lib/sync/discovery', () => ({ configuredSyncApps: () => ['notifuse', 'prospection', 'crm'], discoverAppForEmail: (...a: unknown[]) => m.decouvrir(...a) }));

import { espaceMailVivant, espaceNote, presenceDe, presenceIncomplete, presenteDans } from '@/lib/apps/presence';

const T = { id: 'T', userId: 'proprio', notifuseWorkspaceSlug: 'ws', prospectionProvisionedAt: new Date(), metadata: { crm: { workspace_id: 'c1' } } };
const base = (modules: string[] = [], t: object | null = T) => ({ tenant: { findFirst: async () => t }, user: { findFirst: async () => ({ email: 'a@x.fr' }) }, organisation: { findUnique: async () => ({ modules }) } }) as never;
const vu = (o: Record<string, unknown[] | 'panne'>) => m.decouvrir.mockImplementation(async (app: string) => (o[app] === 'panne' ? { error: 'x' } : o[app] ? { found: true, snapshots: o[app] } : { found: false }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NOTIFUSE_API_URL', 'https://mail.test');
  vi.stubEnv('NOTIFUSE_HUB_API_SECRET', 's');
  m.etat.mockResolvedValue({ status: 'active' });
});

it('espaceNote : ce que le Hub a noté pour chaque app', () => {
  expect([espaceNote(T, 'notifuse'), espaceNote(T, 'prospection'), espaceNote(T, 'crm'), espaceNote(T, 'academy'), espaceNote({ notifuseWorkspaceSlug: null, prospectionProvisionedAt: null, metadata: null }, 'notifuse')]).toEqual(['ws', true, 'c1', null, null]);
});
// 26/11 : une organisation Analytics reliée par `hub link` (external_tenant_id seul) paraissait « sans espace ».
it('espaceNote : un lien de `hub link` sans workspace_id se lit par external_tenant_id', () => {
  expect(espaceNote({ notifuseWorkspaceSlug: null, prospectionProvisionedAt: null, metadata: { analytics: { external_tenant_id: 'org-7' } } }, 'analytics')).toBe('org-7');
});
describe('presenteDans', () => {
  const p = (s: object[]) => { vu({ notifuse: s }); return presenteDans('notifuse', T, { email: 'a@x.fr', hubUserId: 'h' }); };
  it('par le lien au Hub, sinon par l\'identifiant noté ; un espace supprimé ou d\'un autre ne compte pas', async () => {
    expect([await p([{ workspaceId: 'autre', hubTenantLink: 'T' }]), await p([{ workspaceId: 'ws' }]), await p([{ workspaceId: 'ws', status: 'deleted' }]), await p([{ workspaceId: 'autre', hubTenantLink: 'T2' }]), await p([])]).toEqual([true, true, false, false, false]);
  });
  it('Mail liste un espace supprimé sans son état : lu sur l\'espace, il ne compte pas ; illisible, on ne sait pas (25/11)', async () => {
    m.etat.mockResolvedValue({ status: 'deleted', deleted_at: '2026-11-25' });
    expect(await p([{ workspaceId: 'ws' }])).toBe(false);
    m.etat.mockRejectedValue(new Error('502'));
    expect(await p([{ workspaceId: 'ws' }])).toBeNull();
    m.etat.mockImplementation(async (s: string) => ({ status: s === 'ws' ? 'active' : 'deleted' }));
    expect(await p([{ workspaceId: 'vieux', hubTenantLink: 'T' }, { workspaceId: 'ws' }])).toBe(true);
  });
  it('une app muette : on ne sait pas', async () => { vu({ notifuse: 'panne' }); expect(await presenteDans('notifuse', T, { email: 'a', hubUserId: 'h' })).toBeNull(); });
});
describe('presenceDe', () => {
  it('membre : présent, absent d\'une app cochée, pas emmené là où rien n\'est coché, illisible', async () => {
    vu({ notifuse: [{ workspaceId: 'ws' }], crm: 'panne' });
    expect((await presenceDe(base(['prospection']), 'T', 'h')).map((x) => [x.app, x.etat])).toEqual([['notifuse', 'presente'], ['prospection', 'absente'], ['crm', 'illisible']]);
    expect((await presenceDe(base(), 'T', 'h')).find((x) => x.app === 'prospection')?.etat).toBe('non_cochee');
  });
  it('le propriétaire est attendu partout où l\'espace existe ; sans espace, c\'est dit', async () => {
    vu({});
    expect((await presenceDe(base([], { ...T, prospectionProvisionedAt: null }), 'T', 'proprio')).map((x) => x.etat)).toEqual(['absente', 'sans_espace', 'absente']);
  });
  it('organisation inconnue : rien', async () => expect(await presenceDe(base([], null), 'T', 'h')).toEqual([]));
});
it('presenceIncomplete : absente ou illisible, jamais « non cochée »', () => {
  expect([presenceIncomplete([{ app: 'crm', etat: 'absente' }]), presenceIncomplete([{ app: 'crm', etat: 'illisible' }]), presenceIncomplete([{ app: 'crm', etat: 'non_cochee' }, { app: 'notifuse', etat: 'presente' }, { app: 'academy', etat: 'sans_espace' }])]).toEqual([true, true, false]);
});
it('espaceMailVivant : actif seulement ; suspendu ou supprimé non ; sans réglage, sans état ou en panne, on ne sait pas', async () => {
  const lu = async (r: unknown) => { m.etat.mockResolvedValue(r); return espaceMailVivant('ws'); };
  expect([await lu({ status: 'active' }), await lu({ status: 'suspended' }), await lu({ status: 'active', deleted_at: 'x' }), await lu({})]).toEqual([true, false, false, null]);
  vi.stubEnv('NOTIFUSE_API_URL', '');
  expect(await espaceMailVivant('ws')).toBeNull();
});
