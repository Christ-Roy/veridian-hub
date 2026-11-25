// @vitest-environment node
/** Une seconde adresse prouvée par le fournisseur : exactement celle demandée, dans ses domaines, par un membre, jamais celle d'un autre. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ pret: vi.fn(), audits: [] as any[] }));
vi.mock('@/lib/federation/idp', () => ({ idpPret: (...a: unknown[]) => m.pret(...a) }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: async (_d: unknown, l: unknown) => { m.audits.push(l); } }));

import { ADRESSES_MAX } from '@/lib/adresses';
import { ajouterParFournisseur, fournisseurPour, idpDuDomaine, membreVivant, preuveOrganisation } from '@/lib/adresses/federation';

const I = { id: 'i1', tenantId: 'T', issuer: 'https://idp.client.test', clientId: 'c', secret: 's', domaines: ['client.test'], creationAuto: false, test: false };
const U = { id: 'U', email: 'jean@perso.test', emailVerified: new Date(), supabaseUserId: 'h1' };
let emails: any[];
let comptes: any[];
let membres: any[];
let prises: string[];
const db = {
  tenantIdp: { findFirst: async ({ where }: any) => (where.actif && where.domaines.has === 'client.test' ? { id: 'i1' } : null) },
  tenant: { findFirst: async ({ where }: any) => (where.id === 'T' && where.userId === 'proprio' ? { id: 'T' } : null) },
  tenantMember: { findFirst: async ({ where }: any) => membres.find((x) => x.tenantId === where.tenantId && x.userId === where.userId && !x.deletedAt) ?? null },
  account: {
    findUnique: async ({ where: { provider_providerAccountId: w } }: any) => comptes.find((x) => x.provider === w.provider && x.providerAccountId === w.providerAccountId) ?? null,
    findFirst: async ({ where }: any) => comptes.find((x) => x.userId === where.userId && x.provider === where.provider && x.providerAccountId !== where.NOT.providerAccountId) ?? null,
  },
  userEmail: { count: async () => emails.filter((x) => x.userId === 'U').length, create: async ({ data }: any) => { if (prises.includes(data.email)) throw Object.assign(new Error('unique'), { code: 'P2002' }); emails.push(data); } },
} as never;
beforeEach(() => {
  m.audits.length = 0;
  m.pret.mockReset().mockResolvedValue(I);
  emails = [];
  comptes = [];
  membres = [{ tenantId: 'T', userId: 'h1', deletedAt: null }];
  prises = ['prise@client.test'];
});
const ajouter = (x: object = {}, o: { i?: object; u?: object; attendue?: string } = {}) => ajouterParFournisseur(db, { ...I, ...o.i }, { sub: 's1', email: 'jean@client.test', emailNie: false, nom: null, ...x }, { ...U, ...o.u }, o.attendue ?? 'jean@client.test');

describe('ajouterParFournisseur', () => {
  it('prouvée, à elle ; aucun lien de connexion posé ; l\'adresse n\'est pas au journal', async () => {
    expect(await ajouter()).toEqual({ ajoutee: 'jean@client.test' });
    expect(emails).toEqual([expect.objectContaining({ userId: 'U', email: 'jean@client.test', preuve: preuveOrganisation('T') })]);
    expect(comptes).toEqual([]);
    expect(JSON.stringify(m.audits)).not.toContain('client.test');
  });
  it.each<[string, object, object, string]>([
    ['une autre adresse que celle demandée', { email: 'chef@client.test' }, {}, 'autre_adresse'],
    ['hors des domaines', { email: 'jean@ailleurs.test' }, { attendue: 'jean@ailleurs.test' }, 'domaine_refuse'],
    ['dite non vérifiée', { emailNie: true }, {}, 'adresse_non_verifiee'],
    ['sans adresse', { email: null }, {}, 'adresse_absente'],
    ['Google sans hd', {}, { i: { issuer: 'https://accounts.google.com' } }, 'domaine_refuse'],
    ['prise par un autre', { email: 'prise@client.test' }, { attendue: 'prise@client.test' }, 'compte_existant'],
    ['principale non prouvée', {}, { u: { emailVerified: null } }, 'email_not_verified'],
    ['organisation de test, compte réel', { email: 'e2e-x@client.test' }, { i: { test: true }, attendue: 'e2e-x@client.test' }, 'non_attendu'],
  ])('%s : refusée, rien d\'écrit', async (_n, x, o, refus) => {
    expect(await ajouter(x, o as never)).toEqual({ refus });
    expect([emails, m.audits]).toEqual([[], []]);
  });
  it('plus membre depuis la demande, identité d\'un autre compte, seconde identité du même fournisseur, trop d\'adresses', async () => {
    membres[0].deletedAt = new Date();
    expect(await ajouter()).toEqual({ refus: 'non_attendu' });
    membres[0].deletedAt = null;
    comptes = [{ userId: 'V', provider: 'org:i1', providerAccountId: 's1' }];
    expect(await ajouter()).toEqual({ refus: 'autre_identite' });
    comptes = [{ userId: 'U', provider: 'org:i1', providerAccountId: 's0' }];
    expect(await ajouter()).toEqual({ refus: 'autre_identite' });
    comptes = [{ userId: 'U', provider: 'org:i1', providerAccountId: 's1' }];
    emails = Array.from({ length: ADRESSES_MAX }, () => ({ userId: 'U' }));
    expect(await ajouter()).toEqual({ refus: 'trop_d_adresses' });
    emails = [];
    expect(await ajouter(), 'témoin : la même identité').toEqual({ ajoutee: 'jean@client.test' });
  });
});
describe('fournisseurPour', () => {
  it('un membre, dans un domaine tenu ; sinon la même réponse', async () => {
    expect((await fournisseurPour(db, U, 'JEAN@client.test'))?.id).toBe('i1');
    expect([await fournisseurPour(db, U, 'jean@inconnu.test'), await fournisseurPour(db, { ...U, supabaseUserId: 'h9' }, 'jean@client.test'), await fournisseurPour(db, { ...U, supabaseUserId: null }, 'jean@client.test')]).toEqual([null, null, null]);
    m.pret.mockResolvedValue(null);
    expect(await fournisseurPour(db, U, 'jean@client.test'), 'fermé').toBeNull();
  });
});
describe('idpDuDomaine', () => {
  it('le fournisseur d\'une organisation de test ne tient que des comptes de batterie', async () => {
    m.pret.mockResolvedValue({ ...I, test: true });
    expect([await idpDuDomaine(db, 'vrai@client.test'), (await idpDuDomaine(db, 'e2e-sso-x@client.test'))?.id]).toEqual([null, 'i1']);
    expect(await fournisseurPour(db, U, 'e2e-sso-x@client.test'), 'compte réel').toBeNull();
  });
});
describe('membreVivant', () => {
  it('membre vivant, ou propriétaire ; pas un retiré', async () => {
    expect([await membreVivant(db, 'T', 'h1'), await membreVivant(db, 'T', 'proprio'), await membreVivant(db, 'T', 'h9')]).toEqual([true, true, false]);
    membres[0].deletedAt = new Date();
    expect(await membreVivant(db, 'T', 'h1')).toBe(false);
  });
});
describe('preuveOrganisation', () => {
  it('dit l\'organisation', () => expect(preuveOrganisation('T')).toBe('org:T'));
});
