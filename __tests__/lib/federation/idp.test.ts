// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adresseAcceptee, idpPret, issuerAccepte, poserIdp, ReglageIdp, vueIdp } from '@/lib/federation/idp';

const TEST = { organisation_de_test: { expire_le: new Date(Date.now() + 3_600_000).toISOString() } };
let tenants: any[];
let idps: any[];
const db = {
  tenant: { findFirst: async ({ where }: any) => tenants.find((t) => (where.id ? t.id === where.id : t.slug === where.slug) && !t.deletedAt) ?? null },
  tenantIdp: {
    findFirst: async ({ where }: any) => idps.find((x) => x.actif && x.tenantId !== where.NOT.tenantId && x.domaines.some((d: string) => where.domaines.hasSome.includes(d))) ?? null,
    findUnique: async ({ where }: any) => idps.find((x) => (where.id ? x.id === where.id : x.tenantId === where.tenantId)) ?? null,
    delete: async ({ where }: any) => { idps = idps.filter((x) => x.id !== where.id); },
    upsert: async ({ where, create, update }: any) => { const l = idps.find((x) => x.tenantId === where.tenantId); if (l) return Object.assign(l, update); const c = { id: `i${Math.random()}`, ...create }; idps.push(c); return c; },
  },
} as never;
beforeEach(() => {
  vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40));
  tenants = [{ id: 'T', slug: 'client', status: 'active', metadata: {} }, { id: 'E', slug: 'epreuve', status: 'active', metadata: TEST }];
  idps = [];
});
const R = { issuer: 'https://idp.client.test', client_id: 'c', client_secret: 'secret-tres-secret', domaines: ['client.test'] };
const poser = (o: object = {}, tenantId = 'T') => poserIdp(db, { tenantId, reglage: ReglageIdp.parse({ ...R, ...o }), acteur: 'op' });

describe('issuerAccepte', () => {
  it('HTTPS public ; en clair, seulement le tailnet d\'une organisation de test', () => {
    const o = (u: string, t = false) => issuerAccepte(u, t);
    expect([o('https://login.client.fr'), o('https://login.client.fr/realms/a')]).toEqual([true, true]);
    expect(['http://login.client.fr', 'https://127.0.0.1', 'https://10.0.0.1', 'https://[::1]', 'https://localhost', 'https://a.internal', 'https://u:p@client.fr', 'https://client.fr?x=1', 'ftp://client.fr', 'pas une url'].map((u) => o(u, true))).toEqual(Array(10).fill(false));
    expect([o('http://100.64.1.2:4000', true), o('http://100.64.1.2:4000', false), o('http://100.200.1.2', true), o('http://192.168.1.1', true), o('http://169.254.169.254', true), o('http://127.0.0.1', true)]).toEqual([true, false, false, false, false, false]);
  });
});

it('adresseAcceptee : les points publiés par le client ne visent pas nos réseaux', () => {
  expect(['https://idp.client.fr/token?x=1', 'https://10.0.0.1/token', 'https://nomad.internal/v1', 'http://idp.client.fr/token', 'https://a:b@idp.client.fr/t', undefined, 'x'].map((u) => adresseAcceptee(u, false))).toEqual([true, false, false, false, false, false, false]);
});

describe('poserIdp', () => {
  it('le secret est chiffré, jamais rendu ; rejouer met à jour', async () => {
    const a = (await poser()) as { id: string };
    expect(JSON.stringify(idps)).not.toContain('secret-tres-secret');
    expect(JSON.stringify(vueIdp(idps[0]))).not.toMatch(/secret/);
    expect((await poser({ creation_auto: true })) as { id: string }).toEqual(a);
    expect((await idpPret(db, { slug: 'client' }))!.secret).toBe('secret-tres-secret');
  });
  it('un autre émetteur est une autre identité : id neuf, les anciens liens ne valent plus', async () => {
    const a = (await poser()) as { id: string };
    expect(((await poser({ issuer: 'https://autre.client.test' })) as { id: string }).id).not.toBe(a.id);
    expect(idps).toHaveLength(1);
  });
  it('domaine public, le nôtre, déjà pris, tenant inconnu, émetteur refusé : rien n\'est écrit', async () => {
    expect([await poser({ domaines: ['gmail.com'] }), await poser({ domaines: ['client.test', 'OUTLOOK.com'] }), await poser({ domaines: ['veridian.site'] }), await poser({ domaines: ['app.veridian.site'] }), await poser({}, 'X'), await poser({ issuer: 'http://client.test' })]).toEqual([{ refus: 'domaine_public' }, { refus: 'domaine_public' }, { refus: 'domaine_veridian' }, { refus: 'domaine_veridian' }, { refus: 'tenant_introuvable' }, { refus: 'issuer_refuse' }]);
    await poser();
    expect(await poser({}, 'E')).toEqual({ refus: 'domaine_pris' });
    expect(idps).toHaveLength(1);
  });
  it('ReglageIdp : domaines bien formés, champ inconnu refusé', () => {
    for (const x of [{ domaines: [] }, { domaines: ['*.fr'] }, { domaines: ['a'] }, { domaines: ['@client.fr'] }, { pirate: 1 }, { issuer: 'x' }]) expect(ReglageIdp.safeParse({ ...R, ...x }).success, JSON.stringify(x)).toBe(false);
  });
});

describe('idpPret', () => {
  it('éteint, organisation suspendue, supprimée ou inconnue : rien', async () => {
    await poser();
    expect((await idpPret(db, { slug: 'client' }))?.domaines).toEqual(['client.test']);
    idps[0].actif = false;
    expect(await idpPret(db, { slug: 'client' })).toBeNull();
    idps[0].actif = true;
    tenants[0].status = 'suspended';
    expect([await idpPret(db, { slug: 'client' }), await idpPret(db, { id: idps[0].id })]).toEqual([null, null]);
    tenants[0].deletedAt = new Date();
    expect([await idpPret(db, { slug: 'client' }), await idpPret(db, { slug: 'inconnu' }), await idpPret(db, { id: 'x' })]).toEqual([null, null, null]);
  });
  it('la marque de test tombée : l\'adresse privée et nos domaines ne valent plus rien', async () => {
    await poser({ issuer: 'http://100.64.1.2:4000', domaines: ['veridian.site'] }, 'E');
    expect((await idpPret(db, { slug: 'epreuve' }))?.test).toBe(true);
    tenants[1].metadata = {};
    expect(await idpPret(db, { slug: 'epreuve' })).toBeNull();
    idps[0].issuer = 'https://idp.client.test';
    expect(await idpPret(db, { slug: 'epreuve' }), 'nos domaines, même en HTTPS').toBeNull();
  });
});
