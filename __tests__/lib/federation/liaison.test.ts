// @vitest-environment node
/** Relier par sa personne : l'identifiant seul, un `sub` = une personne, membre vivant, rien de créé, aucune adresse crue. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ pret: vi.fn() }));
vi.mock('@/lib/federation/idp', () => ({ idpPret: (...a: unknown[]) => m.pret(...a) }));

import { delier, fournisseurDe, liaisonsDe, nomFournisseur, relierParPersonne } from '@/lib/federation/liaison';

const I = { id: 'i1', tenantId: 'T', issuer: 'https://login.infomaniak.com', clientId: 'c', secret: 's', domaines: [], creationAuto: false, test: false };
const U = { id: 'u', email: 'perso@gmail.com', emailVerified: new Date(), supabaseUserId: 'h' };
const X = { sub: '123456', email: 'autre@gmail.com', emailNie: true, nom: null };
let comptes: any[];
let membre: boolean;
let audits: any[];
let db: any;
beforeEach(() => {
  comptes = [];
  membre = true;
  audits = [];
  m.pret.mockResolvedValue(I);
  db = {
    account: {
      findUnique: async ({ where }: any) => comptes.find((c) => c.provider === where.provider_providerAccountId.provider && c.providerAccountId === where.provider_providerAccountId.providerAccountId) ?? null,
      findFirst: async ({ where }: any) => comptes.find((c) => c.userId === where.userId && c.provider === where.provider && (!where.NOT || c.providerAccountId !== where.NOT.providerAccountId)) ?? null,
      create: async ({ data }: any) => { comptes.push(data); },
      deleteMany: async ({ where }: any) => { const n = comptes.length; comptes = comptes.filter((c) => !(c.userId === where.userId && c.provider === where.provider)); return { count: n - comptes.length }; },
    },
    tenant: { findFirst: async () => null, findMany: async () => [{ id: 'T', name: 'Client' }] },
    tenantMember: { findFirst: async () => (membre ? { userId: 'h' } : null), findMany: async () => [{ tenantId: 'T' }] },
    tenantIdp: { findUnique: async ({ where }: any) => (where.tenantId === 'T' ? { id: 'i1' } : null) },
    auditLog: { create: async ({ data }: any) => { audits.push(data); } },
  };
});
const relier = (u: object = {}, x: object = {}, i: object = {}) => relierParPersonne(db, { ...I, ...i }, { ...X, ...x }, { ...U, ...u } as never);

describe('relierParPersonne', () => {
  it('relie l\'identifiant, jamais l\'adresse ; rejouer ne double rien', async () => {
    expect([await relier(), await relier()]).toEqual([{ reliee: true }, { reliee: true }]);
    expect(comptes).toEqual([{ userId: 'u', type: 'oidc', provider: 'org:i1', providerAccountId: '123456' }]);
    expect([audits.length, JSON.stringify(audits).includes('gmail')]).toEqual([1, false]);
  });
  it('un `sub` = une personne ; une personne = un `sub` par fournisseur', async () => {
    comptes.push({ userId: 'v', provider: 'org:i1', providerAccountId: '123456' });
    expect(await relier()).toEqual({ refus: 'autre_identite' });
    comptes = [{ userId: 'u', provider: 'org:i1', providerAccountId: '999' }];
    expect(await relier()).toEqual({ refus: 'autre_identite' });
    expect(comptes).toHaveLength(1);
  });
  it('pas membre, adresse non prouvée, vrai compte dans une organisation de test : rien', async () => {
    expect([await relier({ emailVerified: null }), await relier({ supabaseUserId: null }), await relier({}, {}, { test: true })]).toEqual([{ refus: 'email_not_verified' }, { refus: 'non_attendu' }, { refus: 'non_attendu' }]);
    membre = false;
    expect(await relier()).toEqual({ refus: 'non_attendu' });
    expect(comptes).toEqual([]);
  });
  it('deux personnes en même temps : la base n\'en garde qu\'une', async () => {
    db.account.create = async () => { throw Object.assign(new Error('x'), { code: 'P2002' }); };
    expect(await relier()).toEqual({ refus: 'autre_identite' });
  });
});
it('fournisseurDe : membre seulement ; organisation de test, comptes de batterie seulement', async () => {
  expect((await fournisseurDe(db, U as never, 'T'))?.id).toBe('i1');
  m.pret.mockResolvedValue({ ...I, test: true });
  expect(await fournisseurDe(db, U as never, 'T')).toBeNull();
  m.pret.mockResolvedValue(null);
  expect(await fournisseurDe(db, U as never, 'T')).toBeNull();
  membre = false;
  m.pret.mockResolvedValue(I);
  expect(await fournisseurDe(db, U as never, 'T')).toBeNull();
});
it('liaisonsDe : nommées, sans secret ni identifiant ; délier rend la main', async () => {
  expect(await liaisonsDe(db, U as never)).toEqual([{ tenant_id: 'T', organisation: 'Client', fournisseur: 'Infomaniak', reliee: false }]);
  await relier();
  expect((await liaisonsDe(db, U as never))[0].reliee).toBe(true);
  expect([await delier(db, U as never, 'T'), await delier(db, U as never, 'T'), await delier(db, U as never, 'X')]).toEqual([true, false, false]);
});
it('nomFournisseur', () => expect(['https://login.infomaniak.com', 'https://idp.client.fr/realms/a', 'x'].map(nomFournisseur)).toEqual(['Infomaniak', 'idp.client.fr', 'votre organisation']));
