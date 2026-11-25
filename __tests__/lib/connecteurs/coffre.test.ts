// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ renouveler: vi.fn(), revoquer: vi.fn(), audits: [] as any[], oublier: vi.fn() }));
vi.mock('@/lib/connecteurs/oauth', () => ({ renouveler: (...a: unknown[]) => m.renouveler(...a), revoquer: (...a: unknown[]) => m.revoquer(...a) }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: async (_d: unknown, l: unknown) => { m.audits.push(l); } }));
vi.mock('@/lib/mcp/cache', () => ({ oublierUtilisateur: (...a: unknown[]) => m.oublier(...a) }));

import { connexionsDe, couper, couperToutes, garder, jetonDe } from '@/lib/connecteurs/coffre';
import { connecteur } from '@/lib/connecteurs/registre';

const N = connecteur('notion')!;
const NOW = Date.parse('2026-11-25T10:00:00Z');
const J = (o: object = {}) => ({ acces: 'acces-1', refresh: 'refresh-1', expireLe: new Date(NOW + 3_600_000), ...o });
let l: any[];
const ok = (x: any, w: any) => Object.entries(w).every(([k, v]) => x[k] === v);
const db = {
  connexionExterne: {
    findMany: async ({ where }: any) => l.filter((x) => ok(x, where)),
    findUnique: async ({ where }: any) => { const x = l.find((y) => (where.id ? y.id === where.id : ok(y, where.hubUserId_connecteur))); return x ? { ...x } : null; },
    upsert: async ({ where, create, update }: any) => { const x = l.find((y) => ok(y, where.hubUserId_connecteur)); if (x) Object.assign(x, update); else l.push({ id: `c${l.length}`, creeLe: new Date(NOW), ...create }); },
    updateMany: async ({ where, data }: any) => { const r = l.filter((x) => ok(x, where)); r.forEach((x) => Object.assign(x, data)); return { count: r.length }; },
    deleteMany: async ({ where }: any) => { l = l.filter((x) => !ok(x, where)); },
  },
} as never;
const jeton = (o: object = {}, u = 'h') => jetonDe(db, u, N, 'https://hub.test/r', { now: NOW, ...o });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40));
  vi.spyOn(console, 'error').mockReturnValue();
  m.audits.length = 0;
  l = [];
  m.revoquer.mockResolvedValue(true);
});

it('garder : chiffré, jamais au journal ; rebrancher remplace ; les outils de la personne se relisent', async () => {
  await garder(db, 'h', 'notion', J());
  await garder(db, 'h', 'notion', J({ acces: 'acces-2' }));
  expect([l.length, /acces-|refresh-/.test(JSON.stringify(l)), /acces-|refresh-/.test(JSON.stringify(m.audits)), m.oublier.mock.calls[0]]).toEqual([1, false, false, ['h', 'notion']]);
});
it('connexionsDe : tout le registre, son état à elle, sans jeton', async () => {
  await garder(db, 'h', 'notion', J());
  const x = await connexionsDe(db, 'h');
  expect([x.find((y) => y.cle === 'notion')?.etat, x.find((y) => y.cle === 'linear')?.etat, JSON.stringify(x).includes('v1.')]).toEqual(['active', 'absente', false]);
  expect((await connexionsDe(db, 'autre')).every((y) => y.etat === 'absente'), 'jamais celles d\'une autre personne').toBe(true);
});

describe('jetonDe', () => {
  beforeEach(() => garder(db, 'h', 'notion', J()));
  it('valable : rendu tel quel ; absente, ou à une autre personne : null', async () => {
    expect([await jeton(), await jeton({}, 'autre'), m.renouveler.mock.calls.length]).toEqual(['acces-1', null, 0]);
  });
  it('fini dans la minute, ou refusé par le service : renouvelé UNE fois, même demandé dix fois à la fois', async () => {
    m.renouveler.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 5)); return J({ acces: 'acces-2', refresh: 'refresh-2' }); });
    expect(await Promise.all(Array.from({ length: 10 }, () => jeton({ now: NOW + 3_590_000 })))).toEqual(Array(10).fill('acces-2'));
    expect([m.renouveler.mock.calls.length, m.renouveler.mock.calls[0][2]]).toEqual([1, 'refresh-1']);
    await jeton({ force: true });
    expect(m.renouveler.mock.calls[1][2], 'avec le jeton tourné').toBe('refresh-2');
  });
  it('le service refuse le renouvellement : à rebrancher, et plus rien ne part', async () => {
    m.renouveler.mockRejectedValue(Object.assign(new Error('x'), { error: 'invalid_grant' }));
    expect([await jeton({ force: true }), l[0].etat, await jeton()]).toEqual([null, 'a_rebrancher', null]);
  });
  it('service en panne : on ne conclut rien', async () => {
    m.renouveler.mockRejectedValue(new Error('ECONNRESET'));
    await expect(jeton({ force: true })).rejects.toThrow('service_injoignable');
    expect([l[0].etat, await jeton()]).toEqual(['active', 'acces-1']);
  });
  it('l\'autre version l\'a renouvelée entre-temps : son jeton à elle, pas un débranchement', async () => {
    m.renouveler.mockImplementation(async () => { await garder(db, 'h', 'notion', J({ acces: 'acces-9' })); throw Object.assign(new Error('x'), { error: 'invalid_grant' }); });
    expect([await jeton({ force: true }), l[0].etat]).toEqual(['acces-9', 'active']);
  });
  it('sans jeton de renouvellement : à rebrancher', async () => {
    await garder(db, 'h', 'notion', J({ refresh: null }));
    expect([await jeton({ now: NOW + 9_000_000 }), l[0].etat]).toEqual([null, 'a_rebrancher']);
  });
});
it('couper : effacée même si le service ne répond pas, et seulement la sienne', async () => {
  await garder(db, 'h', 'notion', J());
  await garder(db, 'v', 'notion', J());
  m.revoquer.mockResolvedValue(false);
  expect(await couper(db, 'h', 'notion', 'r')).toEqual({ coupee: true, revoquee: false });
  expect([l.map((x) => x.hubUserId), m.revoquer.mock.calls[0][2]]).toEqual([['v'], 'refresh-1']);
  expect(await couper(db, 'h', 'notion', 'r')).toEqual({ coupee: false, revoquee: false });
});
it('couperToutes : un compte supprimé n\'en laisse aucune', async () => {
  await garder(db, 'h', 'notion', J());
  await garder(db, 'h', 'linear', J());
  await garder(db, 'v', 'linear', J());
  expect([await couperToutes(db, 'h', 'r'), l.map((x) => x.hubUserId)]).toEqual([2, ['v']]);
});
