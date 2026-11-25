// @vitest-environment node
/** Ajouter une adresse (S1b) : seule une preuve l'ajoute, rien ne dit si elle existe chez nous, jamais volée à un autre. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ADRESSES_MAX, adressesProuvees, CODE_MIN, codesParAdresse, codesParCompte, confirmerCode, demanderCode, detacher, ESSAIS_MAX, titulaireSecondaire } from '@/lib/adresses';

const T0 = new Date('2026-11-25T10:00:00Z');
const U = { id: 'u', email: 'Jean@gmail.com' };
let users: any[];
let emails: any[];
let codes: any[];
let audits: any[];
let envois: any[];
const part = (l: any, w: any) => Object.entries(w).every(([k, v]: any) => (v && typeof v === 'object' && 'gt' in v ? l[k] > v.gt : v && typeof v === 'object' && 'lt' in v ? l[k] < v.lt : v === null ? l[k] == null : l[k] === v));
const db = {
  user: { findUnique: async ({ where }: any) => users.find((x) => x.email === where.email) ?? null },
  userEmail: {
    findFirst: async ({ where }: any) => emails.find((x) => part(x, where)) ?? null,
    findMany: async ({ where }: any) => emails.filter((x) => part(x, where)),
    count: async ({ where }: any) => emails.filter((x) => part(x, where)).length,
    create: async ({ data }: any) => { if (emails.some((x) => x.email === data.email && !x.detacheeLe) || users.some((x) => x.email === data.email)) throw Object.assign(new Error('unique'), { code: 'P2002' }); emails.push({ detacheeLe: null, ...data }); },
    updateMany: async ({ where, data }: any) => { const r = emails.filter((x) => part(x, where)); r.forEach((x) => Object.assign(x, data)); return { count: r.length }; },
  },
  userEmailCode: {
    upsert: async ({ where, create, update }: any) => { const l = codes.find((x) => x.userId === where.userId); if (l) Object.assign(l, update); else codes.push(create); },
    updateMany: async ({ where }: any) => { const r = codes.filter((x) => part(x, where)); r.forEach((x) => { x.essais += 1; }); return { count: r.length }; },
    findUnique: async ({ where }: any) => codes.find((x) => x.userId === where.userId) ?? null,
    deleteMany: async ({ where }: any) => { const n = codes.length; codes = codes.filter((x) => !part(x, where)); return { count: n - codes.length }; },
  },
  auditLog: { create: async ({ data }: any) => { audits.push(data); } },
} as never;
const send = vi.fn(async (m: any) => { envois.push(m); }) as never;
const code = () => /\b(\d{6})\b/.exec(envois.at(-1).text)![1];
const demander = (email = 'pro@client.fr', u = U) => demanderCode(db, u, email, send, T0);
beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', 'secret-de-test');
  vi.spyOn(codesParCompte, 'enforce').mockReturnValue({ ok: true } as never);
  vi.spyOn(codesParAdresse, 'enforce').mockReturnValue({ ok: true } as never);
  users = [{ id: 'u', email: 'jean@gmail.com' }, { id: 'v', email: 'prise@x.fr' }];
  emails = [];
  codes = [];
  audits = [];
  envois = [];
});

describe('demanderCode', () => {
  it('un code part à l\'adresse visée seule ; jamais en clair en base ; une seconde demande remplace la première', async () => {
    expect(await demander(' Pro@Client.fr ')).toBe('demande');
    expect(envois.map((e) => e.to)).toEqual(['pro@client.fr']);
    const un = code();
    expect(JSON.stringify(codes)).not.toContain(un);
    await demander('autre@client.fr');
    expect(codes).toHaveLength(1);
    expect(await confirmerCode(db, U, 'pro@client.fr', un, T0), 'l\'ancien ne vaut plus rien').toBe('code_invalide');
  });
  it('prise comme principale, comme secondaire, la sienne, ou trop d\'adresses : MÊME réponse, aucun mail', async () => {
    emails.push({ userId: 'v', email: 'sec@x.fr', detacheeLe: null });
    expect(await Promise.all(['prise@x.fr', 'sec@x.fr', 'JEAN@gmail.com'].map((e) => demander(e)))).toEqual(['demande', 'demande', 'demande']);
    for (let i = 0; i < ADRESSES_MAX; i++) emails.push({ userId: 'u', email: `s${i}@x.fr`, detacheeLe: null });
    expect(await demander('libre@x.fr')).toBe('demande');
    expect([envois, codes]).toEqual([[], []]);
  });
  it('débit : par compte, dit ; par adresse visée, tu', async () => {
    (codesParCompte.enforce as any).mockReturnValue({ ok: false });
    expect(await demander()).toBe('trop');
    (codesParCompte.enforce as any).mockReturnValue({ ok: true });
    (codesParAdresse.enforce as any).mockReturnValue({ ok: false });
    expect(await demander()).toBe('demande');
    expect(envois).toEqual([]);
  });
});

describe('confirmerCode', () => {
  it('le bon code, une fois ; l\'adresse est prouvée et à elle ; rien d\'elle au journal', async () => {
    await demander();
    const c = code();
    expect(await confirmerCode(db, U, 'PRO@client.fr', c, T0)).toBe('ajoutee');
    expect(emails).toEqual([expect.objectContaining({ userId: 'u', email: 'pro@client.fr', preuve: 'code' })]);
    expect(await confirmerCode(db, U, 'pro@client.fr', c, T0), 'rejeu').toBe('code_invalide');
    expect(JSON.stringify(audits)).not.toContain('client.fr');
  });
  it('faux code, code d\'une autre adresse, d\'une autre personne, mal formé, expiré : rien', async () => {
    await demander();
    const c = code();
    const faux = c === '000000' ? '000001' : '000000';
    expect(await confirmerCode(db, U, 'pro@client.fr', faux, T0)).toBe('code_invalide');
    expect(await confirmerCode(db, U, 'autre@client.fr', c, T0)).toBe('code_invalide');
    expect(await confirmerCode(db, { id: 'v', email: 'prise@x.fr' }, 'pro@client.fr', c, T0)).toBe('code_invalide');
    expect(await confirmerCode(db, U, 'pro@client.fr', `${c} `, T0)).toBe('code_invalide');
    expect(await confirmerCode(db, U, 'pro@client.fr', c, new Date(T0.getTime() + CODE_MIN * 60_000))).toBe('code_invalide');
    expect(emails).toEqual([]);
    expect(await confirmerCode(db, U, 'pro@client.fr', c, T0), 'témoin').toBe('ajoutee');
  });
  it(`${ESSAIS_MAX} essais par code : le bon, ensuite, ne passe plus`, async () => {
    await demander();
    const c = code();
    for (let i = 0; i < ESSAIS_MAX; i++) await confirmerCode(db, U, 'pro@client.fr', c === '111111' ? '222222' : '111111', T0);
    expect(await confirmerCode(db, U, 'pro@client.fr', c, T0)).toBe('code_invalide');
    expect(emails).toEqual([]);
  });
  it('prise entre-temps par un autre : refus, jamais volée', async () => {
    await demander();
    users.push({ id: 'w', email: 'pro@client.fr' });
    expect(await confirmerCode(db, U, 'pro@client.fr', code(), T0)).toBe('prise');
    expect(emails).toEqual([]);
  });
  it('une panne de base n\'est pas un « prise »', async () => {
    await demander();
    const create = (db as any).userEmail.create;
    (db as any).userEmail.create = async () => { throw new Error('connexion'); };
    await expect(confirmerCode(db, U, 'pro@client.fr', code(), T0)).rejects.toThrow('connexion');
    (db as any).userEmail.create = create;
  });
});

it('adressesProuvees, titulaireSecondaire, detacher : une principale non prouvée ne compte pas, une détachée non plus', async () => {
  emails.push({ userId: 'u', email: 'pro@client.fr', detacheeLe: null }, { userId: 'u', email: 'vieille@x.fr', detacheeLe: T0 }, { userId: 'v', email: 'sec@x.fr', detacheeLe: null });
  expect(await adressesProuvees(db, { ...U, emailVerified: T0 })).toEqual(['jean@gmail.com', 'pro@client.fr']);
  expect(await adressesProuvees(db, { ...U, emailVerified: null })).toEqual(['pro@client.fr']);
  expect([await titulaireSecondaire(db, 'PRO@client.fr'), await titulaireSecondaire(db, 'vieille@x.fr')]).toEqual(['u', null]);
  expect([await detacher(db, U, 'sec@x.fr', T0), await detacher(db, U, 'jean@gmail.com', T0), await detacher(db, U, 'Pro@client.fr', T0), await detacher(db, U, 'pro@client.fr', T0)]).toEqual([false, false, true, false]);
  expect(await titulaireSecondaire(db, 'pro@client.fr')).toBeNull();
});
