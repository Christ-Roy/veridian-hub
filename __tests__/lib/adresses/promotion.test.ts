// @vitest-environment node
/** AD-M3 : rendre principale une adresse PROUVÉE. Tout ou rien, jamais par une app qui désigne encore quelqu'un par son adresse. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ push: vi.fn(), decouvrir: vi.fn(), revoquer: vi.fn(), suivre: vi.fn(async (..._a: unknown[]) => []), idp: vi.fn(), membre: vi.fn(), mail: vi.fn(async (..._a: unknown[]) => 1), audits: [] as any[] }));
vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: (...a: unknown[]) => m.push(...a) }));
vi.mock('@/lib/sync/discovery', () => ({ configuredSyncApps: () => ['notifuse', 'prospection', 'analytics', 'crm', 'academy'] }));
vi.mock('@/lib/sync/appartenance', () => ({ humainsDe: async (app: string) => { const r = await m.decouvrir(app); return 'error' in r ? { raison: r.error } : { humains: [{ email: 'autre@x.fr', hub_user_id: null }, { email: 'A@x.fr', hub_user_id: 'un-autre' }, ...(r.found ? [{ email: 'a@X.fr', hub_user_id: null }, { email: 'jean@ancien.test', hub_user_id: null }, { email: 'moi@x.fr' }] : [])] }; } }));

vi.mock('@/lib/auth/session-revocation', () => ({ revokeAllSessions: (...a: unknown[]) => m.revoquer(...a) }));
vi.mock('@/lib/organisations/emission', () => ({ suivreOrganisation: m.suivre }));
vi.mock('@/lib/notifuse/adresse', () => ({ suivreAdresseMail: m.mail }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: async (_d: unknown, l: unknown) => { m.audits.push(l); } }));
vi.mock('@/lib/adresses/federation', async (o) => ({ ...(await o<object>()), idpDuDomaine: (...a: unknown[]) => m.idp(...a), membreVivant: (...a: unknown[]) => m.membre(...a) }));

import { APPS_PAR_ADRESSE } from '@/lib/adresses/garde';
import { promouvoir } from '@/lib/adresses/promotion';

const T0 = new Date('2026-11-25T10:00:00Z');
const PROUVEE = new Date('2026-11-24T00:00:00Z');
const U = { id: 'U', email: 'Jean@Ancien.test', emailVerified: new Date('2026-01-01T00:00:00Z'), supabaseUserId: 'h1' };
let e: { users: any[]; emails: any[]; comptes: any[]; jetons: any[] };
let chez: Record<string, string>;
let refuse: string[];
const ok = (l: any, w: any) => Object.entries(w).every(([k, v]: any) => (v && typeof v === 'object' && 'in' in v ? v.in.includes(l[k]) : v === null ? l[k] == null : l[k] === v));
const maj = (t: string) => async ({ where, data }: any) => { const r = (e as any)[t].filter((x: any) => ok(x, where)); r.forEach((x: any) => Object.assign(x, data)); return { count: r.length }; };
// Les déclencheurs de la base : une adresse active n'appartient qu'à une personne.
const unique = () => { const t = [...e.users.map((x) => x.email.toLowerCase()), ...e.emails.filter((x) => !x.detacheeLe).map((x) => x.email)]; if (new Set(t).size !== t.length) throw Object.assign(new Error('unique'), { code: 'P2002' }); };
const tables = {
  userEmail: { findFirst: async ({ where }: any) => e.emails.find((x) => ok(x, where)) ?? null, updateMany: maj('emails'), update: async (a: any) => { await maj('emails')(a); unique(); }, create: async ({ data }: any) => { const l = { id: `a${e.emails.length}`, detacheeLe: null, ...data }; e.emails.push(l); unique(); return l; }, delete: async ({ where }: any) => { e.emails = e.emails.filter((x) => x.id !== where.id); } },
  user: { updateMany: async (a: any) => { const r = await maj('users')(a); unique(); return r; }, update: async (a: any) => { await maj('users')(a); unique(); } },
  account: { updateMany: maj('comptes') },
  verificationToken: { deleteMany: async ({ where }: any) => { e.jetons = e.jetons.filter((x) => !where.identifier.in.includes(x.identifier)); } },
  tenantMember: { findMany: async () => [{ tenantId: 'T' }] },
};
// La seconde attend la première sur sa ligne, comme Postgres.
let file: Promise<unknown> = Promise.resolve();
const tx = async (f: any) => { const avant = structuredClone(e); try { return await f(tables); } catch (err) { e = avant; throw err; } };
const db = { ...tables, $transaction: (f: any) => { const r = file.then(() => tx(f)); file = r.catch(() => undefined); return r; } } as never;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockReturnValue();
  m.audits.length = 0;
  e = { users: [{ id: 'U', email: U.email, emailVerified: U.emailVerified }, { id: 'V', email: 'autre@x.test' }], emails: [{ id: 's', userId: 'U', email: 'jean@neuf.test', preuve: 'code', prouveeLe: PROUVEE, detacheeLe: null, detacheePar: null }, { id: 'v', userId: 'V', email: 'sec@x.test', preuve: 'code', detacheeLe: null }], comptes: [{ userId: 'U', provider: 'credentials', providerAccountId: U.email }, { userId: 'U', provider: 'google', providerAccountId: 'g' }], jetons: [{ identifier: 'jean@ancien.test' }, { identifier: 'autre@x.test' }] };
  chez = { prospection: 'ok', analytics: 'ok', academy: 'not_in_app', notifuse: 'not_in_app', crm: 'not_in_app' };
  refuse = [];
  m.push.mockImplementation(async (p: any, o: any) => Object.fromEntries(o.apps.map((a: string) => [a, p.email && refuse.includes(a) ? 'failed' : chez[a]])));
  m.decouvrir.mockResolvedValue({ found: false });
  m.idp.mockResolvedValue(null);
  m.membre.mockResolvedValue(true);
  m.revoquer.mockResolvedValue({ appsEnEchec: [] });
});
const aller = (email = 'Jean@Neuf.test', u: any = U) => promouvoir(db, u, email, { now: T0 });
const pousses = () => m.push.mock.calls.filter(([p]) => p.email).map(([p, o]) => [p, o.apps]);
/** Rien n'a bougé : ni chez nous, ni chez une app. */
const intact = () => { expect(e.users[0].email).toBe(U.email); expect(e.emails.map((x) => [x.email, x.detacheeLe])).toEqual([['jean@neuf.test', null], ['sec@x.test', null]]); expect([pousses().length, m.revoquer.mock.calls.length]).toEqual([0, 0]); };

describe('promouvoir', () => {
  it('même personne, nouvelle principale ; l\'ancienne devient un alias ; les apps suivent par hub_user_id ; les sessions tombent', async () => {
    expect(await aller()).toEqual({ promue: 'jean@neuf.test', appsEnEchec: [] });
    expect(e.users[0]).toEqual({ id: 'U', email: 'jean@neuf.test', emailVerified: PROUVEE });
    expect(e.emails.filter((x) => x.userId === 'U').map((x) => [x.email, x.preuve, x.detacheeLe, x.detacheePar])).toEqual([['jean@neuf.test', 'code', T0, 'promotion'], ['jean@ancien.test', 'principale', null, undefined]]);
    expect(e.comptes.map((x) => x.providerAccountId)).toEqual(['jean@neuf.test', 'g']);
    expect(e.jetons, 'plus aucun lien parti à l\'ancienne').toEqual([{ identifier: 'autre@x.test' }]);
    expect(pousses()).toEqual([[{ hubUserId: 'h1', email: 'jean@neuf.test' }, ['prospection', 'analytics']]]);
    expect([m.revoquer.mock.calls[0][1], m.suivre.mock.calls[0][1]]).toEqual([{ id: 'U', supabaseUserId: 'h1' }, 'T']);
    expect(JSON.stringify(m.audits)).not.toMatch(/neuf|ancien/);
  });
  it('rejouée, celle d\'un autre, jamais prouvée, détachée : not_found', async () => {
    expect((await aller('sec@x.test') as any).refus, 'secondaire d\'un autre').toBe('not_found');
    expect((await aller('autre@x.test') as any).refus, 'principale d\'un autre').toBe('not_found');
    expect((await aller('jamais@x.test') as any).refus).toBe('not_found');
    intact();
    await aller();
    expect(await aller('jean@neuf.test', { ...U, email: 'jean@neuf.test' }), 'rejouée').toEqual({ refus: 'not_found' });
    expect(await aller('jean@neuf.test'), 'rejouée avec l\'état d\'avant').toEqual({ refus: 'not_found' });
    expect(pousses()).toHaveLength(1);
  });
  it('deux à la fois : une seule passe', async () => {
    const r = await Promise.all([aller(), aller()]);
    expect(r.filter((x) => 'promue' in x)).toHaveLength(1);
    expect(e.emails.filter((x) => x.userId === 'U' && !x.detacheeLe).map((x) => x.email)).toEqual(['jean@ancien.test']);
  });
  it('principale non prouvée, compte sans identité Hub : aucun droit', async () => {
    expect([await aller(undefined, { ...U, emailVerified: null }), await aller(undefined, { ...U, supabaseUserId: null })]).toEqual([{ refus: 'email_not_verified' }, { refus: 'email_not_verified' }]);
    intact();
  });
  it.each([
    ['prouvée par une autre organisation', 'org:AUTRE', true, 'domaine_federe'],
    ['prouvée par un code, dans un domaine tenu par une organisation', 'code', true, 'domaine_federe'],
    ['prouvée par l\'organisation, mais elle n\'en est plus', 'org:X', false, 'domaine_federe'],
    ['ancienne principale, plus membre', 'principale', false, 'domaine_federe'],
  ])('domaine fédéré, %s : refusée', async (_n, preuve, membre, refus) => {
    m.idp.mockResolvedValue({ tenantId: 'X' });
    m.membre.mockResolvedValue(membre);
    e.emails[0].preuve = preuve;
    expect(await aller()).toEqual({ refus });
    intact();
  });
  it('domaine fédéré : prouvée par SON organisation, ou ancienne principale, elle passe ; l\'organisation ne la confirme plus : refusée', async () => {
    e.emails[0].preuve = 'org:X';
    expect(await aller()).toEqual({ refus: 'preuve_perdue' });
    m.idp.mockResolvedValue({ tenantId: 'X' });
    expect(await aller()).toMatchObject({ promue: 'jean@neuf.test' });
    expect(await aller('jean@ancien.test', { ...U, email: 'jean@neuf.test' }), 'retour').toMatchObject({ promue: 'jean@ancien.test' });
  });
  it('reliée chez Mail et au CRM : ils suivent, et l\'adresse que le Hub garde pour Mail aussi', async () => {
    chez.notifuse = 'ok';
    chez.crm = 'ok';
    expect(await aller()).toMatchObject({ promue: 'jean@neuf.test' });
    expect(pousses()[0][1]).toEqual(['notifuse', 'prospection', 'analytics', 'crm']);
    expect(m.mail.mock.calls.map((c) => c.slice(1))).toEqual([['h1', 'jean@neuf.test']]);
  });
  it('sans compte chez Mail, l\'adresse de Mail n\'est pas touchée', async () => {
    await aller();
    expect(m.mail).not.toHaveBeenCalled();
  });
  it.each(['notifuse', 'crm'])('%s ne la connaît que par son adresse : on s\'arrête avant', async (app) => {
    m.decouvrir.mockImplementation(async (a: string) => ({ found: a === app }));
    expect(await aller()).toEqual({ refus: 'app_non_reliee', apps: [app] });
    intact();
  });
  it.each(['academy'])('un compte chez %s, qui désigne par l\'adresse : on s\'arrête avant', async (app) => {
    expect(APPS_PAR_ADRESSE).toContain(app);
    chez[app] = 'ok';
    expect(await aller()).toEqual({ refus: 'app_par_adresse', apps: [app] });
    chez[app] = 'not_in_app';
    m.decouvrir.mockImplementation(async (a: string) => ({ found: a === app }));
    expect(await aller(), 'pas relié, connu par sa seule adresse').toEqual({ refus: 'app_par_adresse', apps: [app] });
    intact();
  });
  it('compte connu d\'une app par sa seule adresse (il en naîtrait un double), app muette : on s\'arrête avant', async () => {
    chez.analytics = 'not_in_app';
    m.decouvrir.mockImplementation(async (a: string) => ({ found: a === 'analytics' }));
    expect(await aller()).toEqual({ refus: 'app_non_reliee', apps: ['analytics'] });
    m.decouvrir.mockResolvedValue({ error: 'http_500' });
    expect(await aller()).toMatchObject({ refus: 'app_indisponible' });
    m.decouvrir.mockResolvedValue({ found: false });
    for (const muet of ['failed', 'endpoint_missing', 'not_configured']) { chez.prospection = muet; expect(await aller(), muet).toEqual({ refus: 'app_indisponible', apps: ['prospection'] }); }
    intact();
  });
  it('une app refuse la nouvelle adresse : tout revient, chez nous et chez celle qui avait suivi', async () => {
    refuse = ['analytics'];
    expect(await aller()).toEqual({ refus: 'app_refuse', apps: ['analytics'] });
    expect(e.users[0]).toEqual({ id: 'U', email: U.email, emailVerified: U.emailVerified });
    expect(e.emails.filter((x) => x.userId === 'U')).toEqual([expect.objectContaining({ email: 'jean@neuf.test', preuve: 'code', detacheeLe: null, detacheePar: null })]);
    expect(e.comptes[0].providerAccountId).toBe(U.email);
    expect(pousses().map(([p]: any) => p.email)).toEqual(['jean@neuf.test', 'jean@ancien.test']);
    expect(m.revoquer).not.toHaveBeenCalled();
  });
  it('prise entre-temps : la base refuse, rien ne bouge', async () => {
    e.users[1].email = 'jean@neuf.test';
    expect(await aller()).toEqual({ refus: 'prise' });
    expect([e.users[0].email, e.emails[0].detacheeLe, pousses()]).toEqual([U.email, null, []]);
  });
});
