// @vitest-environment node
/** Pré-inscription (VER-227 S1) : jointe au premier passage PROUVÉ, adresse exacte, jamais plus que membre, jamais après un retrait. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ suivre: vi.fn(async (..._a: unknown[]) => []), role: vi.fn(async (..._a: unknown[]) => []) }));
vi.mock('@/lib/organisations/emission', () => ({ suivreOrganisation: m.suivre }));
vi.mock('@/lib/tenants/roles', () => ({ pousserRole: m.role }));

import { annulerPreinscriptions, consommerPreinscriptions, listerPreinscriptions, preinscrire } from '@/lib/tenants/preinscription';

import { base, table } from '../delegation/fausse';

const J = 86_400_000;
const T0 = new Date('2026-11-25T00:00:00Z');
const apres = (j: number) => new Date(T0.getTime() + j * J);
let db: ReturnType<typeof base> & { tenantPreinscription: ReturnType<typeof table>; organisation: unknown; organisationEmission: unknown };
let n = 0;
beforeEach(() => {
  vi.clearAllMocks();
  const t = table();
  const upsert = t.upsert;
  t.upsert = async (x: any) => { const l = t.lignes.find((y: any) => y.tenantId === x.where.tenantId_email.tenantId && y.email === x.where.tenantId_email.email); return l ? Object.assign(l, x.update) : upsert({ where: { id: 'aucun' }, create: { id: `p${++n}`, ...x.create }, update: {} }); };
  db = { ...base(), tenantPreinscription: t, organisation: table(), organisationEmission: table() } as never;
  db.tenant.lignes.push({ id: 'T', userId: 'prop', status: 'active', deletedAt: null }, { id: 'S', userId: 'prop', status: 'active', deletedAt: null });
  db.user.lignes.push({ supabaseUserId: 'u', email: 'jean.dupont+x@gmail.com', emailVerified: T0 }, { supabaseUserId: 'flou', email: 'flou@gmail.com', emailVerified: null });
});
const poser = (email = 'Jean.Dupont+x@Gmail.com ', tenantId = 'T') => preinscrire(db as never, { tenantId, email, acteur: 'op' }, T0);
const passer = (qui = 'u', quand = apres(1)) => consommerPreinscriptions(db as never, qui, {}, quand);
const membre = (tenantId = 'T', userId = 'u') => db.tenantMember.lignes.find((x: any) => x.tenantId === tenantId && x.userId === userId) as any;

describe('consommerPreinscriptions', () => {
  it('joint une fois, en membre, prévient les apps ; un second passage n\'écrit rien', async () => {
    await poser();
    expect(await passer()).toEqual(['T']);
    expect(membre()).toMatchObject({ role: 'member', origine: 'preinscription' });
    expect(m.suivre.mock.calls.map((c) => c[1])).toEqual(['T']);
    expect(db.tenantPreinscription.lignes[0]).toMatchObject({ consommeeLe: apres(1), hubUserId: 'u' });
    expect(await passer()).toEqual([]);
    expect(m.suivre).toHaveBeenCalledTimes(1);
  });
  it('adresse non prouvée, autre adresse (même sans le +), compte inconnu : rien', async () => {
    await poser('flou@gmail.com');
    await poser('jean.dupont@gmail.com');
    await poser('jeandupont+x@gmail.com');
    expect([await passer('flou'), await passer('u'), await passer('inconnu')]).toEqual([[], [], []]);
    expect(db.tenantMember.lignes).toHaveLength(0);
  });
  it('expirée ou annulée : rien ; un geste neuf la rouvre', async () => {
    await poser();
    expect(await passer('u', apres(31))).toEqual([]);
    expect(await annulerPreinscriptions(db as never, { tenantId: 'T', email: 'JEAN.dupont+x@gmail.com' }, T0)).toBe(1);
    expect(await passer()).toEqual([]);
    await poser();
    expect(await passer()).toEqual(['T']);
  });
  it('retiré depuis : ne revient pas par une pré-inscription d\'avant ; par une neuve, si', async () => {
    await poser();
    db.tenantMember.lignes.push({ tenantId: 'T', userId: 'u', role: 'member', deletedAt: apres(0.5) });
    expect(await passer()).toEqual([]);
    expect(db.tenantPreinscription.lignes[0].annuleeLe, 'ne vaut plus rien').toEqual(apres(1));
    await preinscrire(db as never, { tenantId: 'T', email: 'jean.dupont+x@gmail.com', acteur: 'op' }, apres(2));
    expect(await passer('u', apres(3))).toEqual(['T']);
    expect(membre().deletedAt).toBeNull();
  });
  it('organisation suspendue : attend la reprise ; supprimée : ne vaut plus rien ; une en panne n\'empêche pas l\'autre', async () => {
    await poser();
    await poser(undefined, 'S');
    db.tenant.lignes[0].status = 'suspended';
    expect(await passer()).toEqual(['S']);
    expect(db.tenantPreinscription.lignes[0]).toMatchObject({ consommeeLe: null, annuleeLe: null });
    db.tenant.lignes[0].deletedAt = T0;
    expect(await passer()).toEqual([]);
    expect(db.tenantPreinscription.lignes[0].annuleeLe).toEqual(apres(1));
  });
  it('déjà membre : son rôle ne bouge pas', async () => {
    await poser();
    db.tenantMember.lignes.push({ tenantId: 'T', userId: 'u', role: 'admin', deletedAt: null });
    await passer();
    expect(membre().role).toBe('admin');
  });
  it('l\'app échoue à suivre : la personne est membre, et la ligne est consommée seulement après', async () => {
    await poser();
    m.suivre.mockRejectedValueOnce(new Error('base coupée'));
    await expect(passer()).rejects.toThrow('base coupée');
    expect([membre().role, db.tenantPreinscription.lignes[0].consommeeLe]).toEqual(['member', null]);
    expect(await passer(), 'rejouée').toEqual(['T']);
  });
});

it('listerPreinscriptions dit l\'état de chacune', async () => {
  await poser('a@x.fr');
  await poser('b@x.fr');
  await annulerPreinscriptions(db as never, { tenantId: 'T', email: 'b@x.fr' }, T0);
  expect((await listerPreinscriptions(db as never, 'T', apres(1))).map((p) => [p.email, p.etat])).toEqual([['a@x.fr', 'en_attente'], ['b@x.fr', 'annulee']]);
  expect((await listerPreinscriptions(db as never, 'T', apres(40)))[0].etat).toBe('expiree');
});
