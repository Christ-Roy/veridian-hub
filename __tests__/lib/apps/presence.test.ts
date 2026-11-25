// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ decouvrir: vi.fn() }));
vi.mock('@/lib/sync/discovery', () => ({ configuredSyncApps: () => ['notifuse', 'prospection', 'crm'], discoverAppForEmail: (...a: unknown[]) => m.decouvrir(...a) }));

import { espaceNote, presenceDe, presenceIncomplete, presenteDans } from '@/lib/apps/presence';

const T = { id: 'T', userId: 'proprio', notifuseWorkspaceSlug: 'ws', prospectionProvisionedAt: new Date(), metadata: { crm: { workspace_id: 'c1' } } };
const base = (modules: string[] = [], t: object | null = T) => ({ tenant: { findFirst: async () => t }, user: { findFirst: async () => ({ email: 'a@x.fr' }) }, organisation: { findUnique: async () => ({ modules }) } }) as never;
const vu = (o: Record<string, unknown[] | 'panne'>) => m.decouvrir.mockImplementation(async (app: string) => (o[app] === 'panne' ? { error: 'x' } : o[app] ? { found: true, snapshots: o[app] } : { found: false }));
beforeEach(() => vi.clearAllMocks());

it('espaceNote : ce que le Hub a noté pour chaque app', () => {
  expect([espaceNote(T, 'notifuse'), espaceNote(T, 'prospection'), espaceNote(T, 'crm'), espaceNote(T, 'academy'), espaceNote({ notifuseWorkspaceSlug: null, prospectionProvisionedAt: null, metadata: null }, 'notifuse')]).toEqual(['ws', true, 'c1', null, null]);
});
describe('presenteDans', () => {
  const p = (s: object[]) => { vu({ notifuse: s }); return presenteDans('notifuse', T, { email: 'a@x.fr', hubUserId: 'h' }); };
  it('par le lien au Hub, sinon par l\'identifiant noté ; un espace supprimé ou d\'un autre ne compte pas', async () => {
    expect([await p([{ workspaceId: 'autre', hubTenantLink: 'T' }]), await p([{ workspaceId: 'ws' }]), await p([{ workspaceId: 'ws', status: 'deleted' }]), await p([{ workspaceId: 'autre', hubTenantLink: 'T2' }]), await p([])]).toEqual([true, true, false, false, false]);
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
