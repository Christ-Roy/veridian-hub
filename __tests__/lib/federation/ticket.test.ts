// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { consommerTicket, emettreTicket, federationExpiree, SESSION_FEDEREE_S } from '@/lib/federation/ticket';

const base = () => {
  const l: any[] = [];
  return { l, federationTicket: { deleteMany: async ({ where }: any) => { const r = l.filter((x) => (where.empreinte ? x.empreinte === where.empreinte : x.expireLe < where.expireLe.lt)); r.forEach((x) => l.splice(l.indexOf(x), 1)); return { count: r.length }; }, create: async ({ data }: any) => { l.push(data); }, findUnique: async ({ where }: any) => l.find((x) => x.empreinte === where.empreinte) ?? null } };
};
describe('ticket', () => {
  it('une fois, 60 s, jamais stocké en clair ; deux lectures simultanées n\'en gagnent qu\'une', async () => {
    const db = base();
    const t = await emettreTicket(db as never, 'U', 1_000_000);
    expect(JSON.stringify(db.l)).not.toContain(t);
    expect(await Promise.all([consommerTicket(db as never, t, 1_000_001), consommerTicket(db as never, t, 1_000_001)]).then((r) => r.filter(Boolean))).toEqual(['U']);
    expect(await consommerTicket(db as never, t, 1_000_001)).toBeNull();
    const vieux = await emettreTicket(db as never, 'U', 1_000_000);
    expect([await consommerTicket(db as never, vieux, 1_060_001), db.l.length]).toEqual([null, 0]);
  });
  it('inventé, mal formé, absent : rien', async () => {
    for (const t of ['x'.repeat(43), 'court', undefined, 12, { a: 1 }, `${'x'.repeat(43)}/`]) expect(await consommerTicket(base() as never, t)).toBeNull();
  });
});
it('federationExpiree : 24 h depuis la connexion réelle ; une session ordinaire ne tombe pas', () => {
  const n = 2_000_000;
  const f = (x: object) => federationExpiree(x, n);
  expect([f({ federe: true, authAt: n - SESSION_FEDEREE_S }), f({ federe: true, authAt: n - SESSION_FEDEREE_S - 1 }), f({ federe: true }), f({ authAt: 0 }), f({ federe: 'true', authAt: 0 })]).toEqual([false, true, true, false, false]);
  expect(SESSION_FEDEREE_S).toBe(86_400);
});
