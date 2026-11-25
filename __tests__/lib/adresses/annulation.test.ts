// @vitest-environment node
/** AD-M3 : l'ancienne adresse annule le changement. La sortie de secours de qui on a pris la session : elle marche une fois, et retire tout ce qui ouvrait. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ push: vi.fn(), revoquer: vi.fn(), mail: vi.fn(async () => 1), audits: [] as any[] }));
vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: (...a: unknown[]) => m.push(...a) }));
vi.mock('@/lib/auth/session-revocation', () => ({ revokeAllSessions: (...a: unknown[]) => m.revoquer(...a) }));
vi.mock('@/lib/notifuse/adresse', () => ({ suivreAdresseMail: m.mail }));
vi.mock('@/lib/email/send', () => ({ sendMail: vi.fn() }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: async (_d: unknown, l: unknown) => { m.audits.push(l); } }));
vi.mock('@/utils/helpers', () => ({ getURL: () => 'https://hub.test' }));

import { annulationOuverte, ANNULATION_H, annuler, prevenirAncienne } from '@/lib/adresses/annulation';

const T0 = Date.parse('2026-11-25T10:00:00Z');
const H = 3_600_000;
let e: { users: any[]; emails: any[]; comptes: any[]; jetons: any[] };
const vaut = (v: any, w: any): boolean => (w && typeof w === 'object' && !(w instanceof Date) ? ('in' in w ? w.in.includes(v) : 'startsWith' in w ? String(v).startsWith(w.startsWith) : 'gte' in w ? v >= w.gte : 'gt' in w ? v > w.gt : false) : w === null ? v == null : v === w);
const ok = (l: any, w: any): boolean => Object.entries(w).every(([k, v]: any) => (k === 'OR' ? v.some((x: any) => ok(l, x)) : vaut(l[k], v)));
const tables = {
  verificationToken: {
    create: async ({ data }: any) => { e.jetons.push(data); },
    count: async ({ where }: any) => e.jetons.filter((x) => ok(x, where)).length,
    findUnique: async ({ where }: any) => e.jetons.find((x) => ok(x, where)) ?? null,
    deleteMany: async ({ where }: any) => { const n = e.jetons.length; e.jetons = e.jetons.filter((x) => !ok(x, where)); return { count: n - e.jetons.length }; },
  },
  user: { findUnique: async ({ where }: any) => { const u = e.users.find((x) => ok(x, where)); return u ? { ...u } : null; }, update: async ({ where, data }: any) => { if (e.users.some((x) => x.id !== where.id && x.email === data.email)) throw Object.assign(new Error('u'), { code: 'P2002' }); Object.assign(e.users.find((x) => ok(x, where)), data); } },
  userEmail: { findFirst: async ({ where }: any) => { const l = e.emails.find((x) => ok(x, where)); return l ? { ...l } : null; }, update: async ({ where, data }: any) => Object.assign(e.emails.find((x) => ok(x, where)), data), updateMany: async ({ where, data }: any) => { e.emails.filter((x) => ok(x, where)).forEach((x) => Object.assign(x, data)); } },
  account: { deleteMany: async ({ where }: any) => { e.comptes = e.comptes.filter((x) => !ok(x, where)); } },
};
const db = { ...tables, $transaction: async (f: any) => { const a = structuredClone(e); try { return await f(tables); } catch (err) { e = a; throw err; } } } as never;
const envois: any[] = [];
const send = async (x: any) => { envois.push(x); };
const jeton = () => new URL(/https:\S+/.exec(envois[0].text)![0]).searchParams.get('token')!;
const prevenir = (aliasId = 'anc') => prevenirAncienne(db, { userId: 'U', ancienne: 'jean@ancien.test', aliasId }, { send: send as never, now: T0 });
beforeEach(() => {
  vi.clearAllMocks();
  m.audits.length = 0;
  envois.length = 0;
  m.push.mockResolvedValue({ notifuse: 'ok', crm: 'failed' });
  m.revoquer.mockResolvedValue({ appsEnEchec: ['crm'] });
  e = {
    users: [{ id: 'U', email: 'pirate@x.test', supabaseUserId: 'h' }],
    emails: [
      { id: 'anc', userId: 'U', email: 'jean@ancien.test', preuve: 'principale', prouveeLe: new Date(T0 - 900 * H), detacheeLe: null },
      { id: 'vieille', userId: 'U', email: 'jean@perso.test', preuve: 'code', prouveeLe: new Date(T0 - 800 * H), detacheeLe: null },
      { id: 'fraiche', userId: 'U', email: 'pirate2@x.test', preuve: 'code', prouveeLe: new Date(T0 - 2 * H), detacheeLe: null },
      { id: 'chaine', userId: 'U', email: 'pirate3@x.test', preuve: 'principale', prouveeLe: new Date(T0 - 700 * H), detacheeLe: null },
      { id: 'autre', userId: 'V', email: 'v@x.test', preuve: 'principale', prouveeLe: new Date(T0), detacheeLe: null },
    ],
    comptes: [{ userId: 'U', provider: 'credentials' }, { userId: 'U', provider: 'google' }, { userId: 'V', provider: 'google' }],
    jetons: [{ identifier: 'pirate@x.test', token: 'reset' }, { identifier: 'email-proof:U:x', token: 'preuve' }, { identifier: 'onboard:V', token: 'v' }],
  };
});

describe('prevenirAncienne et annulationOuverte', () => {
  it('le lien ne part qu\'à l\'ancienne adresse, vaut 72 h, et n\'est pas gardé en clair', async () => {
    await prevenir();
    expect(envois.map((x) => x.to)).toEqual(['jean@ancien.test']);
    expect(JSON.stringify(e.jetons)).not.toContain(jeton());
    expect(await annulationOuverte(db, 'U', 'anc', new Date(T0 + (ANNULATION_H - 1) * H))).toBe(true);
    expect([await annulationOuverte(db, 'U', 'anc', new Date(T0 + (ANNULATION_H + 1) * H)), await annulationOuverte(db, 'U', 'vieille', new Date(T0)), await annulationOuverte(db, 'V', 'anc', new Date(T0))]).toEqual([false, false, false]);
  });
});

describe('annuler', () => {
  const go = (t: unknown = jeton(), now = T0 + H) => annuler(db, t, { send: send as never, now });
  it('l\'adresse est rendue ; celles venues avec le changement partent, les siennes d\'avant restent ; rien de ce qui ouvrait ne reste', async () => {
    await prevenir();
    expect(await go()).toEqual({ rendue: true, appsEnEchec: ['crm'] });
    expect(e.users[0]).toMatchObject({ email: 'jean@ancien.test', emailVerified: new Date(T0 - 900 * H) });
    expect(e.emails.filter((x) => !x.detacheeLe).map((x) => x.id)).toEqual(['vieille', 'autre']);
    expect(e.comptes, 'mot de passe et fournisseurs').toEqual([{ userId: 'V', provider: 'google' }]);
    expect(e.jetons.map((x) => x.token), 'aucun lien du compte ne survit').toEqual(['v']);
    expect(m.revoquer.mock.calls[0][1]).toEqual({ id: 'U', supabaseUserId: 'h' });
    expect(m.push.mock.calls[0][0]).toEqual({ hubUserId: 'h', email: 'jean@ancien.test' });
    expect([m.mail.mock.calls.length, envois.at(-1).to]).toEqual([1, 'pirate@x.test']);
    expect(m.audits[0].action).toBe('adresse.changement_annule');
    expect(JSON.stringify(m.audits)).not.toMatch(/@/);
  });
  it('une fois : rejoué, périmé, forgé, d\'un autre usage, ou sans ligne : rien', async () => {
    await prevenir();
    const t = jeton();
    expect(await go(t, T0 + 73 * H)).toEqual({ refus: 'invalide' });
    for (const x of ['', null, 'a'.repeat(43), 'court']) expect(await go(x)).toEqual({ refus: 'invalide' });
    e.emails[0].detacheeLe = new Date();
    expect(await go(t)).toEqual({ refus: 'invalide' });
    e.emails[0].detacheeLe = null;
    expect(await go(t)).toMatchObject({ rendue: true });
    expect(await go(t)).toEqual({ refus: 'invalide' });
    expect(m.revoquer).toHaveBeenCalledTimes(1);
  });
  it('le lien d\'une adresse venue ensuite ne défait pas l\'annulation', async () => {
    await prevenir('anc');
    const ancien = jeton();
    envois.length = 0;
    await prevenir('chaine');
    const pirate = jeton();
    expect(await go(ancien)).toMatchObject({ rendue: true });
    expect(await go(pirate)).toEqual({ refus: 'invalide' });
  });
  it('adresse prise entre-temps : refusée, rien n\'a bougé', async () => {
    await prevenir();
    e.users.push({ id: 'W', email: 'jean@ancien.test' });
    expect(await go()).toEqual({ refus: 'prise' });
    expect([e.users[0].email, e.comptes.length, m.revoquer.mock.calls.length]).toEqual(['pirate@x.test', 3, 0]);
  });
});
