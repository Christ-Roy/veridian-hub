// @vitest-environment node
/** Première entrée : seule une adresse que l'organisation ATTEND, prouvée par un code reçu, lie l'identifiant. Jamais une adresse dite. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ preuve: vi.fn(), relier: vi.fn(), entrer: vi.fn(), secondaire: null as string | null }));
vi.mock('@/lib/auth/email-proof-provider', () => ({ applyProviderEmailProof: (...a: unknown[]) => m.preuve(...a) }));
vi.mock('@/lib/adresses', async () => { const { RateLimiter } = await import('@/lib/auth/rate-limit'); return { codesParAdresse: new RateLimiter({ capacity: 4, windowMs: 3_600_000, name: 't' }), titulaireSecondaire: async () => m.secondaire }; });
vi.mock('@/lib/workspace/provision', () => ({ provisionDefaultWorkspace: async () => ({}) }));
vi.mock('@/lib/email/send', () => ({ sendMail: vi.fn() }));
vi.mock('@/lib/federation/identite', () => ({ fournisseur: (i: { id: string }) => `org:${i.id}`, relier: (...a: unknown[]) => m.relier(...a), entrer: (...a: unknown[]) => m.entrer(...a) }));

import { codesParAdresse } from '@/lib/adresses';
import { CODE_PREMIERE_MIN, codesPremiere, confirmerPremiere, COOKIE_PREMIERE, demanderPremiere, essaisPremiere, ouvrirPremiere, PREMIERE_S, scellerPremiere } from '@/lib/federation/premiere';

const T0 = new Date('2026-11-25T10:00:00Z');
const I = { id: 'i1', tenantId: 'T', domaines: [], test: false } as never;
const P = { idp: 'i1', sub: '1741079' };
let users: any[];
let membres: any[];
let inscrits: any[];
let comptes: any[];
let jetons: any[];
let envois: any[];
const ok = (x: any, w: any) => Object.entries(w).every(([k, v]: any) => (v && typeof v === 'object' && 'gt' in v ? x[k] > v.gt : v === null ? x[k] == null : x[k] === v));
const db = {
  user: { findUnique: async ({ where }: any) => users.find((u) => ok(u, where)) ?? null, create: async ({ data }: any) => { const u = { id: `n${users.length}`, ...data }; users.push(u); return u; } },
  tenant: { findFirst: async () => ({ userId: 'proprio' }) },
  tenantMember: { findFirst: async ({ where }: any) => membres.find((x) => ok(x, where)) ?? null },
  tenantPreinscription: { count: async ({ where }: any) => inscrits.filter((x) => x.email === where.email && x.tenantId === where.tenantId).length },
  account: { findUnique: async ({ where: { provider_providerAccountId: w } }: any) => comptes.find((x) => ok(x, w)) ?? null, findFirst: async ({ where }: any) => comptes.find((x) => ok(x, where)) ?? null },
  verificationToken: { deleteMany: async ({ where }: any) => { const n = jetons.length; jetons = jetons.filter((x) => !ok(x, where)); return { count: n - jetons.length }; }, create: async ({ data }: any) => { jetons.push(data); }, findFirst: async ({ where }: any) => jetons.find((x) => ok(x, where)) ?? null },
} as never;
const send = async (x: any) => { envois.push(x); };
const demander = (email: string, p = P, i = I) => demanderPremiere(db, i, p, email, send as never, T0);
const code = () => /\d{6}/.exec(envois.at(-1).text)![0];
const confirmer = (email: string, c: string, p = P, now = new Date(T0.getTime() + 60_000)) => confirmerPremiere(db, I, p, email, c, now);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', 's'.repeat(40));
  vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40));
  for (const l of [codesPremiere, essaisPremiere, codesParAdresse]) l.reset();
  m.secondaire = null;
  m.entrer.mockImplementation(async (_d: unknown, _i: unknown, q: object) => q);
  users = [{ id: 'M', email: 'celine@asd.test', supabaseUserId: 'hM', emailVerified: T0 }, { id: 'X', email: 'autre@x.test', supabaseUserId: 'hX', emailVerified: T0 }, { id: 'N', email: 'henri@asd.test', supabaseUserId: 'hN', emailVerified: null }];
  membres = [{ id: 'm1', tenantId: 'T', userId: 'hM', deletedAt: null }, { id: 'm2', tenantId: 'T', userId: 'hN', deletedAt: null }];
  inscrits = [{ tenantId: 'T', email: 'neuf@asd.test' }];
  comptes = [];
  jetons = [];
  envois = [];
});

describe('demanderPremiere', () => {
  it('même réponse, qu\'elle soit attendue ou non ; le code ne part qu\'à une adresse attendue, jamais en clair en base', async () => {
    expect([await demander('Celine@ASD.test'), await demander('neuf@asd.test'), await demander('autre@x.test'), await demander('inconnue@x.test')]).toEqual(['demande', 'demande', 'demande', 'demande']);
    expect(envois.map((e) => e.to)).toEqual(['celine@asd.test', 'neuf@asd.test']);
    expect(JSON.stringify(jetons)).not.toContain(code());
  });
  it('débit borné par identifiant', async () => {
    const r: string[] = [];
    for (let n = 0; n < 6; n++) r.push(await demander(`a${n}@x.test`));
    expect(r).toEqual(['demande', 'demande', 'demande', 'demande', 'demande', 'trop']);
  });
  it('retirée de l\'organisation, ou d\'une autre : rien ne part', async () => {
    membres = [{ id: 'm1', tenantId: 'T', userId: 'hM', deletedAt: T0 }, { id: 'm9', tenantId: 'AUTRE', userId: 'hX', deletedAt: null }];
    await demander('celine@asd.test');
    await demander('autre@x.test');
    expect(envois).toEqual([]);
  });
  it('organisation de test : comptes de batterie seulement', async () => {
    await demander('celine@asd.test', P, { ...(I as object), test: true } as never);
    expect(envois).toEqual([]);
  });
});

describe('confirmerPremiere', () => {
  it('membre prouvée : liée pour de bon, elle entre ; le code ne sert qu\'une fois', async () => {
    await demander('celine@asd.test');
    const c = code();
    expect(await confirmer('Celine@asd.test', c)).toEqual({ userId: 'M', hubUserId: 'hM', neuf: false });
    expect(m.relier.mock.calls[0].slice(2)).toEqual(['M', '1741079']);
    expect(m.preuve).not.toHaveBeenCalled();
    expect(await confirmer('celine@asd.test', c)).toEqual({ refus: 'code_faux' });
  });
  it('jamais prouvée : ce code est la première preuve, ce qui précédait tombe', async () => {
    await demander('henri@asd.test');
    await confirmer('henri@asd.test', code());
    expect(m.preuve.mock.calls[0].slice(1)).toEqual(['N', 'org:i1', { providerAccountId: '1741079', sessions: 'toujours' }]);
  });
  it('pré-inscrite sans compte : créée avec l\'adresse prouvée, elle entre', async () => {
    await demander('neuf@asd.test');
    expect(await confirmer('neuf@asd.test', code())).toMatchObject({ neuf: true });
    expect(users.at(-1)).toMatchObject({ email: 'neuf@asd.test' });
    expect(users.at(-1).emailVerified).toBeInstanceOf(Date);
  });
  it('code faux, périmé, d\'un autre identifiant, d\'une autre adresse, d\'un autre fournisseur : rien n\'est lié', async () => {
    await demander('celine@asd.test');
    const c = code();
    for (const x of ['000000' === c ? '111111' : '000000', '', 'abcdef']) expect(await confirmer('celine@asd.test', x)).toEqual({ refus: 'code_faux' });
    essaisPremiere.reset();
    expect(await confirmer('celine@asd.test', c, P, new Date(T0.getTime() + (CODE_PREMIERE_MIN + 1) * 60_000))).toEqual({ refus: 'code_faux' });
    expect(await confirmer('celine@asd.test', c, { ...P, sub: '999' })).toEqual({ refus: 'code_faux' });
    expect(await confirmer('celine@asd.test', c, { ...P, idp: 'i2' })).toEqual({ refus: 'code_faux' });
    expect(await confirmer('henri@asd.test', c)).toEqual({ refus: 'code_faux' });
    expect(m.relier).not.toHaveBeenCalled();
  });
  it('cinq essais', async () => {
    await demander('celine@asd.test');
    const c = code();
    for (let n = 0; n < 5; n++) await confirmer('celine@asd.test', 'xxxxxx');
    expect(await confirmer('celine@asd.test', c)).toEqual({ refus: 'trop' });
  });
  it('un sub = une personne ; une personne = un sub', async () => {
    await demander('celine@asd.test');
    const c = code();
    comptes = [{ provider: 'org:i1', providerAccountId: '1741079', userId: 'X' }];
    expect(await confirmer('celine@asd.test', c)).toEqual({ refus: 'autre_identite' });
    comptes = [{ provider: 'org:i1', providerAccountId: 'ancien', userId: 'M' }];
    await demander('celine@asd.test');
    expect(await confirmer('celine@asd.test', code())).toEqual({ refus: 'autre_identite' });
    expect(m.relier).not.toHaveBeenCalled();
  });
  it('retirée entre le code et sa saisie : non attendue', async () => {
    await demander('celine@asd.test');
    membres = [];
    expect(await confirmer('celine@asd.test', code())).toEqual({ refus: 'non_attendu' });
    expect(m.relier).not.toHaveBeenCalled();
  });
});

describe('scellerPremiere, ouvrirPremiere', () => {
  it('15 min, illisible, ne se forge pas', () => {
    const c = scellerPremiere(P, T0.getTime());
    expect(c).not.toContain('1741079');
    expect([ouvrirPremiere(c, T0.getTime() + 60_000), ouvrirPremiere(c, T0.getTime() + PREMIERE_S * 1000 + 1_000), ouvrirPremiere(undefined), ouvrirPremiere(`${c.slice(0, -3)}AAA`, T0.getTime())]).toEqual([P, null, null, null]);
  });
});
it('COOKIE_PREMIERE : un cookie à lui', () => expect(COOKIE_PREMIERE).not.toMatch(/federation$/));
it('PREMIERE_S : un quart d\'heure', () => expect(PREMIERE_S).toBe(900));
it('CODE_PREMIERE_MIN : plus court que la demande', () => expect(CODE_PREMIERE_MIN * 60).toBeLessThan(PREMIERE_S));
