// @vitest-environment node
/** De l'identité affirmée au compte : jamais un compte existant repris par son adresse, jamais hors des domaines déclarés, jamais un retiré. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ suivre: vi.fn(async (..._a: unknown[]) => []), role: vi.fn(async (..._a: unknown[]) => []), ws: vi.fn(async (..._a: unknown[]) => ({ created: true })) }));
vi.mock('@/lib/organisations/emission', () => ({ suivreOrganisation: m.suivre }));
vi.mock('@/lib/tenants/roles', () => ({ pousserRole: m.role }));
vi.mock('@/lib/workspace/provision', () => ({ provisionDefaultWorkspace: m.ws }));

import { adresseAffirmee, fournisseur, resoudreIdentite, type Connecte } from '@/lib/federation/identite';

import { base, table } from '../delegation/fausse';

const T0 = new Date('2026-11-01T00:00:00Z');
const I = { id: 'i1', tenantId: 'T', issuer: 'https://idp.client.test', clientId: 'c', secret: 's', domaines: ['client.test'], creationAuto: false, test: false };
let db: any;
beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  const user = table();
  user.create = async ({ data }: any) => { const l = { id: `n${++n}`, ...data }; user.lignes.push(l); return l; };
  const account = table();
  const un = account.findUnique;
  account.findUnique = async ({ where }: any) => un({ where: where.provider_providerAccountId });
  // Prisma `not`, `notIn` et `NOT`, tels que la purge des liens non prouvés les emploie.
  account.deleteMany = async ({ where }: any) => {
    const part = (a: any) => a.userId === where.userId && (typeof where.provider === 'string' ? a.provider === where.provider : where.provider?.not !== undefined ? a.provider !== where.provider.not : !where.provider?.notIn?.includes(a.provider)) && !(where.NOT && a.provider === where.NOT.provider && a.providerAccountId === where.NOT.providerAccountId);
    const r = account.lignes.filter(part);
    r.forEach((x: any) => account.lignes.splice(account.lignes.indexOf(x), 1));
    return { count: r.length };
  };
  db = { ...base(), user, account, tenantPreinscription: { ...table(), count: async ({ where }: any) => db.tenantPreinscription.lignes.filter((p: any) => p.tenantId === where.tenantId && p.email === where.email && !p.consommeeLe && !p.annuleeLe && p.expireLe > where.expireLe.gt).length }, organisation: table(), organisationEmission: table() };
  db.tenant.lignes.push({ id: 'T', userId: 'prop', status: 'active', deletedAt: null });
  db.user.lignes.push({ id: 'U1', supabaseUserId: 'h1', email: 'jean@client.test', emailVerified: T0 }, { id: 'U2', supabaseUserId: 'h2', email: 'flou@client.test', emailVerified: null }, { id: 'U3', supabaseUserId: 'h3', email: 'ext@ailleurs.test', emailVerified: T0 });
  // Posé par un usurpateur AVANT toute preuve de flou@client.test.
  db.account.lignes.push({ id: 'a1', userId: 'U2', type: 'credentials', provider: 'credentials', providerAccountId: 'flou@client.test' }, { id: 'a2', userId: 'U2', type: 'oauth', provider: 'google', providerAccountId: 'g-pirate' });
});
const aller = (x: object = {}, i: object = {}, connecte: Connecte = null) => resoudreIdentite(db, { ...I, ...i }, { sub: 's1', email: 'neuf@client.test', emailNie: false, nom: 'N', ...x }, connecte);
const liens = (userId: string) => db.account.lignes.filter((a: any) => a.userId === userId).map((a: any) => a.provider);
const membres = () => db.tenantMember.lignes.map((x: any) => [x.userId, x.role, x.origine]);

describe('adresseAffirmee', () => {
  it('ce que le fournisseur a le droit de dire', () => {
    const x = { sub: 's', email: 'a@client.test', emailNie: false, nom: null };
    expect([adresseAffirmee(I, x), adresseAffirmee(I, { ...x, email: 'a@ailleurs.test' }), adresseAffirmee({ ...I, test: true }, x), adresseAffirmee(I, { ...x, emailNie: true })]).toEqual([{ email: 'a@client.test' }, { refus: 'domaine_refuse' }, { refus: 'domaine_refuse' }, { refus: 'adresse_non_verifiee' }]);
  });
});

describe('resoudreIdentite : qui entre', () => {
  it('attendue (création ouverte, ou pré-inscrite) : compte neuf, prouvé, relié, membre ; puis la même identité le retrouve, quelle que soit son adresse', async () => {
    expect(await aller({}, { creationAuto: true })).toMatchObject({ neuf: true });
    const u = db.user.lignes.find((x: any) => x.email === 'neuf@client.test');
    expect([u.emailVerified instanceof Date, liens(u.id), membres()]).toEqual([true, [fournisseur(I)], [[u.supabaseUserId, 'member', 'federation']]]);
    expect(await aller({ email: 'autre-nom@client.test' })).toEqual({ userId: u.id, hubUserId: u.supabaseUserId, neuf: false });
    expect(await aller({ email: 'plus@du-tout.test' })).toMatchObject({ userId: u.id });
    db.tenantPreinscription.lignes.push({ tenantId: 'T', email: 'pre@client.test', consommeeLe: null, annuleeLe: null, expireLe: new Date(Date.now() + 1000) });
    expect(await aller({ sub: 's2', email: 'pre@client.test' })).toMatchObject({ neuf: true });
    expect(m.suivre).toHaveBeenCalledTimes(2);
  });
  it('Google Workspace : le domaine gère le compte, il entre', async () => {
    expect(await aller({ hd: 'client.test' }, { creationAuto: true, issuer: 'https://accounts.google.com' })).toMatchObject({ neuf: true });
  });
  it('M2 : compte jamais prouvé, ouvert par un autre : le fournisseur du domaine est la première preuve, ce qui précédait tombe', async () => {
    expect(await aller({ email: 'flou@client.test' })).toMatchObject({ userId: 'U2', neuf: false });
    expect(liens('U2')).toEqual([fournisseur(I)]);
    expect(db.user.lignes[1]).toMatchObject({ emailVerified: expect.any(Date), sessionsValidAfter: expect.any(Date) });
  });
  it('compte existant et prouvé : relié seulement par sa personne, connectée, avec la même adresse', async () => {
    expect(await aller({ email: 'jean@client.test' })).toEqual({ refus: 'compte_existant' });
    expect(await aller({ email: 'jean@client.test' }, {}, { userId: 'U3', email: 'ext@ailleurs.test' }), 'un autre connecté').toEqual({ refus: 'compte_existant' });
    expect([liens('U1'), membres()], 'rien n\'est écrit').toEqual([[], []]);
    expect(await aller({ email: 'jean@client.test' }, {}, { userId: 'U1', email: 'Jean@client.test' })).toMatchObject({ userId: 'U1' });
    expect(liens('U1')).toEqual([fournisseur(I)]);
    expect(liens('U1').length, 'ensuite sans session').toBe(1);
    expect(await aller({ email: 'jean@client.test' })).toMatchObject({ userId: 'U1' });
  });
});

describe('resoudreIdentite : adresse secondaire (S1b)', () => {
  it('c\'est un compte existant : jamais repris, jamais un second compte ; sa personne connectée le relie', async () => {
    db.userEmail.lignes.push({ userId: 'U3', email: 'pro@client.test', detacheeLe: null });
    expect(await aller({ email: 'pro@client.test' }, { creationAuto: true })).toEqual({ refus: 'compte_existant' });
    expect(await aller({ email: 'pro@client.test' }, { creationAuto: true }, { userId: 'U1', email: 'jean@client.test' })).toEqual({ refus: 'compte_existant' });
    expect(db.user.lignes).toHaveLength(3);
    expect(await aller({ email: 'pro@client.test' }, {}, { userId: 'U3', email: 'ext@ailleurs.test' })).toMatchObject({ userId: 'U3' });
  });
  it('M2 ne s\'y applique pas : un compte non prouvé ne se purge pas par une secondaire', async () => {
    db.userEmail.lignes.push({ userId: 'U2', email: 'sec@client.test', detacheeLe: null });
    expect(await aller({ email: 'sec@client.test' })).toEqual({ refus: 'compte_existant' });
    expect(liens('U2')).toEqual(['credentials', 'google']);
  });
});

describe('resoudreIdentite : qui n\'entre pas', () => {
  it.each<[string, object, object, string]>([
    ['hors domaine', { email: 'ext@ailleurs.test' }, { creationAuto: true }, 'domaine_refuse'],
    ['sous-domaine', { email: 'x@sous.client.test' }, { creationAuto: true }, 'domaine_refuse'],
    ['domaine en suffixe', { email: 'x@pirate-client.test' }, { creationAuto: true }, 'domaine_refuse'],
    ['deux arobases', { email: 'x@client.test@pirate.test' }, { creationAuto: true }, 'adresse_absente'],
    ['sans adresse', { email: null }, { creationAuto: true }, 'adresse_absente'],
    ['adresse niée', { emailNie: true }, { creationAuto: true }, 'adresse_non_verifiee'],
    ['pas attendue', {}, {}, 'non_attendu'],
    ['Google, compte personnel à adresse d\'entreprise', { hd: null }, { creationAuto: true, issuer: 'https://accounts.google.com' }, 'domaine_refuse'],
    ['Google, autre Workspace', { hd: 'autre.test' }, { creationAuto: true, issuer: 'https://accounts.google.com' }, 'domaine_refuse'],
    ['organisation de test, vraie personne', { email: 'neuf@client.test' }, { creationAuto: true, test: true }, 'domaine_refuse'],
  ])('%s', async (_n, x, i, refus) => {
    expect(await aller(x, i)).toEqual({ refus });
    expect([db.account.lignes.length, membres(), db.user.lignes.length]).toEqual([2, [], 3]);
  });
  it('AD-M1, adresse recyclée : une autre identité du même fournisseur ne reprend pas le compte', async () => {
    await aller({ email: 'flou@client.test' });
    expect(await aller({ sub: 'un-autre', email: 'flou@client.test' })).toEqual({ refus: 'autre_identite' });
    expect(liens('U2')).toEqual([fournisseur(I)]);
  });
  it('le `sub` d\'un autre fournisseur ne vaut rien ici', async () => {
    db.account.lignes.push({ id: 'a3', userId: 'U1', type: 'oidc', provider: 'org:autre', providerAccountId: 's1' });
    expect(await aller({ email: 'jean@client.test' })).toEqual({ refus: 'compte_existant' });
  });
  it('retirée de l\'organisation : son fournisseur ne la fait pas revenir', async () => {
    await aller({}, { creationAuto: true });
    db.tenantMember.lignes[0].deletedAt = new Date();
    expect(await aller()).toEqual({ refus: 'retire' });
    expect(db.tenantMember.lignes[0].deletedAt).toBeInstanceOf(Date);
  });
  it('organisation suspendue entre-temps : refusée', async () => {
    db.tenant.lignes[0].status = 'suspended';
    expect(await aller({}, { creationAuto: true })).toEqual({ refus: 'organisation_indisponible' });
  });
  it('pré-inscrite ailleurs, expirée ou annulée : pas attendue', async () => {
    const p = { tenantId: 'T', email: 'neuf@client.test', consommeeLe: null, annuleeLe: null, expireLe: new Date(Date.now() + 1000) };
    db.tenantPreinscription.lignes.push({ ...p, tenantId: 'AUTRE' }, { ...p, expireLe: T0 }, { ...p, annuleeLe: T0 });
    expect(await aller()).toEqual({ refus: 'non_attendu' });
  });
});
