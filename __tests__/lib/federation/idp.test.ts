// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { adresseAcceptee, Alias, certificatLu, idpEssai, idpPret, issuerAccepte, poserIdp, ReglageIdp, ReglageSaml, reglerIdpLibre, SessionJours, vueIdp } from '@/lib/federation/idp';

import { ouvrirSaml } from '../../../e2e/systeme-sso/lib/saml-jetable';

const TEST = { organisation_de_test: { expire_le: new Date(Date.now() + 3_600_000).toISOString() } };
let tenants: any[];
let idps: any[];
const db = {
  tenant: { findFirst: async ({ where }: any) => tenants.find((t) => (where.id ? t.id === where.id : t.slug === where.slug) && !t.deletedAt && t.id !== where.NOT?.id) ?? null },
  tenantIdp: {
    findFirst: async ({ where }: any) => where.alias !== undefined ? idps.find((x) => x.alias === where.alias && x.tenantId !== where.NOT.tenantId) ?? null : idps.find((x) => x.actif && x.tenantId !== where.NOT.tenantId && x.domaines.some((d: string) => where.domaines.hasSome.includes(d))) ?? null,
    findUnique: async ({ where }: any) => idps.find((x) => (where.id ? x.id === where.id : where.alias ? x.alias === where.alias : x.tenantId === where.tenantId)) ?? null,
    update: async ({ where, data }: any) => Object.assign(idps.find((x) => x.id === where.id), data),
    delete: async ({ where }: any) => { idps = idps.filter((x) => x.id !== where.id); },
    upsert: async ({ where, create, update }: any) => { const l = idps.find((x) => x.tenantId === where.tenantId); if (l) return Object.assign(l, update); const c = { id: `i${Math.random()}`, ...create }; idps.push(c); return c; },
  },
  tenantConnexion: { findFirst: async ({ where }: any) => (where.tenantId === obligatoire ? { tenantId: obligatoire } : null) },
  account: { deleteMany: async ({ where }: any) => { delies.push(where.provider); return { count: 1 }; } },
} as never;
let delies: string[] = [];
let obligatoire: string | null = null;
beforeEach(() => {
  vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40));
  tenants = [{ id: 'T', slug: 'client', status: 'active', metadata: {} }, { id: 'E', slug: 'epreuve', status: 'active', metadata: TEST }];
  idps = [];
});
it('obligatoire : le propriétaire ne coupe, ne retire ni ne remplace le fournisseur par lequel chacun passe', async () => {
  const r = ReglageIdp.parse({ issuer: 'https://idp.client.test', client_id: 'c', client_secret: 's', domaines: [] });
  await poserIdp(db, { tenantId: 'T', reglage: r, acteur: 'u', libreService: true });
  obligatoire = 'T';
  try {
    for (const g of ['couper', 'retirer'] as const) expect(await reglerIdpLibre(db, 'T', g)).toEqual({ refus: 'obligatoire_actif' });
    expect(await poserIdp(db, { tenantId: 'T', reglage: r, acteur: 'u', libreService: true })).toEqual({ refus: 'obligatoire_actif' });
  } finally { obligatoire = null; }
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
    expect(ReglageIdp.safeParse({ ...R, domaines: [] }).success, 'sans domaine : chacun relie le sien').toBe(true);
    for (const x of [{ domaines: [], creation_auto: true }, { domaines: ['*.fr'] }, { domaines: ['a'] }, { domaines: ['@client.fr'] }, { pirate: 1 }, { issuer: 'x' }]) expect(ReglageIdp.safeParse({ ...R, ...x }).success, JSON.stringify(x)).toBe(false);
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

describe('SAML et libre-service (VER-227)', () => {
  let cert = '';
  beforeAll(async () => { const x = await ouvrirSaml(); cert = x.certificat; await x.fermer(); });
  beforeEach(() => { delies = []; });
  const SAML = () => ({ protocole: 'saml' as const, issuer: 'urn:client', sso_url: 'https://idp.client.test/sso?x=1', certificat: cert });
  const poserS = (o: object = {}, plus: object = {}) => poserIdp(db, { tenantId: 'T', reglage: ReglageSaml.parse({ ...SAML(), ...o }), acteur: 'op', ...plus });
  const libre = (o: object = {}) => poserIdp(db, { tenantId: 'T', reglage: ReglageIdp.parse({ ...R, ...o }), acteur: 'user:p', libreService: true });

  it('certificatLu : un vrai, en PEM ou nu ; rien d\'autre, ni périmé', () => {
    const nu = cert.replace(/-----[A-Z ]+-----|\s/g, '');
    expect([certificatLu(cert), certificatLu(nu)].map((x) => x?.startsWith('-----BEGIN CERTIFICATE-----'))).toEqual([true, true]);
    expect([certificatLu('pas un certificat'), certificatLu('QUJD'), certificatLu(cert, Date.now() + 30 * 86_400_000)]).toEqual([null, null, null]);
  });
  it('Alias : lisible, jamais un chemin', () => expect(['asd', 'a', 'ASD', 'a/b', '-asd', 'asd-', 'mon-entreprise'].map((x) => Alias.safeParse(x).success)).toEqual([true, false, false, false, false, false, true]));
  it('ReglageSaml : strict, jamais de domaine', () => expect([ReglageSaml.safeParse(SAML()).success, ReglageSaml.safeParse({ ...SAML(), domaines: ['client.test'] }).success]).toEqual([true, false]));
  it('posé : prêt, sans domaine, l\'émetteur gardé tel quel ; certificat périmé ensuite : fermé', async () => {
    expect('id' in (await poserS())).toBe(true);
    const i = (await idpPret(db, { slug: 'client' }))!;
    expect([i.protocole, i.issuer, i.domaines, i.saml?.ssoUrl]).toEqual(['saml', 'urn:client', [], 'https://idp.client.test/sso?x=1']);
    idps[0].samlCertificat = 'x';
    expect(await idpPret(db, { slug: 'client' })).toBeNull();
  });
  it('adresse privée, ou certificat illisible : refusés', async () => {
    expect(await poserS({ sso_url: 'https://10.0.0.1/sso' })).toEqual({ refus: 'issuer_refuse' });
    expect(await poserS({ certificat: 'A'.repeat(200) })).toEqual({ refus: 'certificat_refuse' });
  });
  it('l\'alias ouvre la porte, et ne prend ni celle d\'une autre ni son nom', async () => {
    await poserS({}, { alias: 'mon-entreprise' });
    expect((await idpPret(db, { slug: 'mon-entreprise' }))?.tenantId).toBe('T');
    expect(await poserIdp(db, { tenantId: 'E', reglage: ReglageIdp.parse({ ...R, domaines: [] }), acteur: 'op', alias: 'mon-entreprise' })).toEqual({ refus: 'alias_pris' });
    expect(await poserIdp(db, { tenantId: 'E', reglage: ReglageIdp.parse({ ...R, domaines: [] }), acteur: 'op', alias: 'client' })).toEqual({ refus: 'alias_pris' });
    await poserS();
    expect(idps[0].alias, 'absent : gardé').toBe('mon-entreprise');
  });
  it('une durée se lit dans la vue, sans secret', async () => {
    await poserS({}, { sessionJours: 7 });
    expect(vueIdp({ ...idps[0], poseLe: new Date() }).session_jours).toBe(7);
  });
  it('SessionJours : 2 à 30 ; gardée si absente, retirée par null', async () => {
    expect([1, 2, 30, 31, 7.5].map((x) => SessionJours.safeParse(x).success)).toEqual([false, true, true, false, false]);
    await poserS({}, { sessionJours: 7 });
    await poserS();
    expect(idps[0].sessionJours).toBe(7);
    await poserS({}, { sessionJours: null });
    expect(idps[0].sessionJours).toBeNull();
  });
  it('idpEssai : le fournisseur du propriétaire, même inactif ; jamais celui d\'un opérateur', async () => {
    await libre();
    expect([await idpPret(db, { slug: 'client' }), (await idpEssai(db, 'T'))?.tenantId]).toEqual([null, 'T']);
    idps[0].libreService = false;
    expect(await idpEssai(db, 'T')).toBeNull();
  });
  it('le propriétaire n\'affirme ni domaine ni compte, même s\'il les envoie', async () => {
    await libre({ domaines: ['client.test'], creation_auto: true, actif: true });
    expect([idps[0].domaines, idps[0].creationAuto, idps[0].actif, idps[0].libreService]).toEqual([[], false, false, true]);
  });
  it('reglerIdpLibre : jamais actif sans essai ; changer le réglage redemande l\'essai ; retirer délie', async () => {
    await libre();
    expect(await reglerIdpLibre(db, 'T', 'activer')).toEqual({ refus: 'essai_manquant' });
    idps[0].essaiLe = new Date();
    expect(await reglerIdpLibre(db, 'T', 'activer')).toEqual({ ok: true });
    expect((await idpPret(db, { slug: 'client' }))?.domaines).toEqual([]);
    await libre({ client_secret: 'neuf' });
    expect([idps[0].actif, idps[0].essaiLe]).toEqual([false, null]);
    const id = idps[0].id;
    expect(await reglerIdpLibre(db, 'T', 'retirer')).toEqual({ ok: true });
    expect([idps, delies]).toEqual([[], [`org:${id}`]]);
    expect(await reglerIdpLibre(db, 'T', 'couper')).toEqual({ refus: 'absent' });
  });
  it('ce qu\'un opérateur a posé ne se change pas en libre-service', async () => {
    await poser();
    expect(await libre()).toEqual({ refus: 'pose_par_veridian' });
    expect(await reglerIdpLibre(db, 'T', 'couper')).toEqual({ refus: 'pose_par_veridian' });
    expect(idps[0].domaines).toEqual(['client.test']);
  });
  it('passer d\'OIDC à SAML : une autre identité, id neuf', async () => {
    await libre();
    const id = idps[0].id;
    await poserS({}, { libreService: true });
    expect(idps[0].id).not.toBe(id);
  });
});
