// @vitest-environment node
/** Qui est venu PAR l'organisation : noté à l'émission qui fait entrer ; déjà là, invité ou douteux : « main », gardé. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ decouvrir: vi.fn() }));
vi.mock('@/lib/sync/discovery', () => ({ discoverAppForEmail: (...a: unknown[]) => m.decouvrir(...a) }));

import { avecRecoche, noterInvite, noterVenus, releverAvant, RESERVEES, rouvrir } from '@/lib/organisations/acces';

import { base } from './fausse';

const J = '2026-11-01T00:00:00.000Z';
const doc = (ids = ['p', 'u', 'v']) => ({ hub_tenant_id: 'T', membres: ids.map((x) => ({ hub_user_id: x, email: `${x}@x.fr`, email_proven: true as const, name: null, role: x === 'p' ? 'owner' : 'member', joined_at: J })) }) as never;
let db: ReturnType<typeof base>;
const notes = () => db.organisationAcces.lignes.map((n: any) => [n.app, n.hubUserId, n.origine, n.retireLe ?? null]);
beforeEach(() => { db = base(); m.decouvrir.mockReset().mockResolvedValue({ found: false }); });
const relever = (d = doc()) => releverAvant(db as never, d, 'crm', 'p');

describe('releverAvant', () => {
  it('absent de l\'espace : venu par elle ; déjà là : à la main ; l\'app ne répond pas : à la main ; le propriétaire : jamais', async () => {
    m.decouvrir.mockImplementation(async (_a: string, e: string) => (e.startsWith('u') ? { found: true, snapshots: [{ hubTenantLink: 'T', status: 'active' }] } : { found: true, snapshots: [{ hubTenantLink: 'un-autre', status: 'active' }] }));
    expect(await relever()).toEqual([{ hubUserId: 'u', origine: 'main' }, { hubUserId: 'v', origine: 'organisation' }]);
    m.decouvrir.mockResolvedValue({ error: 'timeout' });
    expect(await relever()).toEqual([{ hubUserId: 'u', origine: 'main' }, { hubUserId: 'v', origine: 'main' }]);
  });
  it('déjà noté : plus jamais redemandé', async () => {
    db.organisationAcces.lignes.push({ tenantId: 'T', app: 'crm', hubUserId: 'u', origine: 'organisation' });
    expect((await relever()).map((x) => x.hubUserId)).toEqual(['v']);
    expect(m.decouvrir).toHaveBeenCalledTimes(1);
  });
});
describe('noterVenus', () => {
  it('la première origine reste', async () => {
    await noterVenus(db as never, 'T', 'crm', [{ hubUserId: 'u', origine: 'main' }]);
    await noterVenus(db as never, 'T', 'crm', [{ hubUserId: 'u', origine: 'organisation' }, { hubUserId: 'v', origine: 'organisation' }]);
    expect(notes()).toEqual([['crm', 'u', 'main', null], ['crm', 'v', 'organisation', null]]);
  });
});
describe('rouvrir et avecRecoche', () => {
  it('rouvrir : seuls ceux venus par elle, de cette app ; avecRecoche : leur adhésion devient postérieure au retrait', async () => {
    const R = new Date('2026-11-25T10:00:00.000Z');
    db.organisationAcces.lignes.push({ tenantId: 'T', app: 'crm', hubUserId: 'u', origine: 'organisation', retireLe: new Date(0) }, { tenantId: 'T', app: 'crm', hubUserId: 'v', origine: 'main', retireLe: null }, { tenantId: 'T', app: 'academy', hubUserId: 'u', origine: 'organisation', retireLe: new Date(0) });
    expect(await avecRecoche(db as never, doc(), 'crm')).toEqual(doc());
    await rouvrir(db as never, 'T', 'crm', R);
    expect(db.organisationAcces.lignes.map((n: any) => [n.app, n.hubUserId, n.retireLe, n.rejointLe])).toEqual([['crm', 'u', null, R], ['crm', 'v', null, undefined], ['academy', 'u', new Date(0), undefined]]);
    const d = (await avecRecoche(db as never, doc(), 'crm')) as any;
    expect(d.membres.map((x: any) => x.joined_at)).toEqual([J, R.toISOString(), J]);
    expect(((await avecRecoche(db as never, doc(), 'academy')) as any).membres.map((x: any) => x.joined_at)).toEqual([J, J, J]);
  });
  it('avecRecoche : une adhésion plus récente que la recoche l\'emporte', async () => {
    db.organisationAcces.lignes.push({ tenantId: 'T', app: 'crm', hubUserId: 'u', origine: 'organisation', rejointLe: new Date('2026-01-01') });
    expect(((await avecRecoche(db as never, doc(), 'crm')) as any).membres[1].joined_at).toBe(J);
  });
});
describe('noterInvite', () => {
  it('invité à la main, même venu par elle d\'abord : gardé ; une app ouverte à tous : rien', async () => {
    db.organisationAcces.lignes.push({ tenantId: 'T', app: 'crm', hubUserId: 'u', origine: 'organisation', retireLe: null });
    await noterInvite(db as never, 'T', 'crm', 'u');
    await noterInvite(db as never, 'T', 'academy', 'v');
    for (const a of ['notifuse', 'prospection', 'analytics']) await noterInvite(db as never, 'T', a, 'u');
    expect(notes()).toEqual([['crm', 'u', 'main', null], ['academy', 'v', 'main', null]]);
  });
});
it('RESERVEES : le CRM et Academy', () => expect(RESERVEES).toEqual(['crm', 'academy']));
