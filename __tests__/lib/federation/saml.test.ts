// @vitest-environment node
/** Le dialogue SAML contre un VRAI fournisseur (jetable) : tout ce qu'il peut fausser est refusé, et le témoin passe. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdpPret } from '@/lib/federation/idp';
import { ouvrir } from '@/lib/federation/oidc';
import { CHEMIN_ACS, CHEMIN_SUITE, COOKIE_SAML, COOKIE_SUITE, demarrerSaml, entiteSp, identifiantDurable, ouvrirSuite, refusXml, scellerSuite, SUITE_S, terminerSaml } from '@/lib/federation/saml';

import { ouvrirSaml, type MensongeSaml } from '../../../e2e/systeme-sso/lib/saml-jetable';

const BASE = new URL('https://hub.test');
let idp: Awaited<ReturnType<typeof ouvrirSaml>>;
let i: IdpPret;
beforeAll(async () => {
  vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40));
  idp = await ouvrirSaml();
  i = { id: 'idp1', tenantId: 'T', issuer: idp.issuer, clientId: '', secret: '', domaines: [], creationAuto: false, test: true, protocole: 'saml', saml: { ssoUrl: idp.sso, certificat: idp.certificat } };
});
afterAll(() => idp.fermer());
beforeEach(() => { idp.mentir(null); idp.dire('sub-1'); });

async function aller(o: Parameters<typeof demarrerSaml>[2] = {}) {
  const d = await demarrerSaml(i, BASE, o);
  const u = new URL(d.url);
  return { u, t: ouvrir(d.cookie)!, demande: idp.lire(u) };
}
const finir = async (x?: Awaited<ReturnType<typeof aller>>) => { const a = x ?? (await aller()); return terminerSaml(i, a.t, idp.repondre(a.demande), BASE); };

describe('demarrerSaml', () => {
  it('une demande neuve à chaque fois, notre retour, notre entité pour cette organisation, un identifiant persistant', async () => {
    const [a, b] = [await aller(), await aller()];
    expect(a.u.href.startsWith(`${idp.sso}?`)).toBe(true);
    expect([a.demande.acs, a.demande.sp, a.demande.id]).toEqual([`https://hub.test${CHEMIN_ACS}`, entiteSp({ tenantId: 'T' }, BASE), a.t.state]);
    expect(a.t.state).not.toBe(b.t.state);
    expect(a.demande.brut).toContain('nameid-format:persistent');
    expect(entiteSp({ tenantId: 'A' }, BASE)).not.toBe(entiteSp({ tenantId: 'B' }, BASE));
  });
  it('qui relie, ou qui essaie, est scellé', async () => {
    expect((await aller({ relier: { userId: 'U' } })).t.relier).toEqual({ userId: 'U' });
    expect((await aller({ essai: { userId: 'V' } })).t.essai).toEqual({ userId: 'V' });
  });
});

describe('terminerSaml', () => {
  it('témoin : l\'identifiant seul, aucune adresse', async () => {
    expect(await finir()).toEqual({ sub: 'sub-1', email: null, emailNie: true, nom: null });
  });
  it.each<[Exclude<MensongeSaml, null>]>([['signature'], ['sans_signature'], ['audience'], ['emetteur'], ['expire'], ['autre_demande'], ['sans_demande'], ['sha1'], ['adresse'], ['ephemere'], ['deux_assertions'], ['commentaire'], ['apres_signature']])('%s : refusé', async (m) => {
    idp.mentir(m);
    await expect(finir()).rejects.toThrow();
  });
  it('la réponse d\'une autre demande, d\'une autre organisation, ou signée par un autre certificat : refusée', async () => {
    const [a, b] = [await aller(), await aller()];
    await expect(terminerSaml(i, b.t, idp.repondre(a.demande), BASE)).rejects.toThrow();
    await expect(terminerSaml({ ...i, tenantId: 'AUTRE' }, a.t, idp.repondre(a.demande), BASE)).rejects.toThrow();
    await expect(terminerSaml({ ...i, saml: { ssoUrl: idp.sso, certificat: idp.autreCertificat } }, a.t, idp.repondre(a.demande), BASE)).rejects.toThrow();
  });
  it('trop gros : refusé avant d\'être lu', async () => {
    await expect(terminerSaml(i, (await aller()).t, 'A'.repeat(400_000), BASE)).rejects.toThrow('trop_gros');
  });
});

it('refusXml : entités, commentaires, plusieurs assertions, chiffrement, SHA-1', () => {
  const a = '<saml:Assertion ID="1"></saml:Assertion>';
  expect([a, `<!DOCTYPE x>${a}`, `<!ENTITY x>${a}`, `${a}<!-- -->`, a + a, '', `${a}<saml:EncryptedAssertion>`, `${a}http://www.w3.org/2000/09/xmldsig#rsa-sha1`].map(refusXml)).toEqual([null, 'xml_refuse', 'xml_refuse', 'xml_refuse', 'assertions', 'assertions', 'chiffree', 'sha1']);
});

it('identifiantDurable : jamais une adresse ni un identifiant d\'un jour ; chez Microsoft, l\'objet', () => {
  const p = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
  expect([
    identifiantDurable({ nameID: 'abc', nameIDFormat: p }),
    identifiantDurable({ nameID: 'a@b.fr', nameIDFormat: p }),
    identifiantDurable({ nameID: 'abc', nameIDFormat: p.replace('persistent', 'transient') }),
    identifiantDurable({ nameID: 'abc', nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' }),
    identifiantDurable({}),
    identifiantDurable({ issuer: 'https://sts.windows.net/x/', nameID: 'a@b.fr', attributes: { 'http://schemas.microsoft.com/identity/claims/objectidentifier': 'oid' } }),
    identifiantDurable({ issuer: 'https://pirate.test', nameID: 'a@b.fr', attributes: { 'http://schemas.microsoft.com/identity/claims/objectidentifier': 'oid' } }),
  ]).toEqual(['abc', null, null, null, null, 'oid', null]);
});

it('CHEMIN_SUITE : sous la réponse postée, un chemin à elle', () => expect(CHEMIN_SUITE.startsWith(`${CHEMIN_ACS}/`)).toBe(true));
it('COOKIE_SAML et COOKIE_SUITE : deux cookies, jamais celui de l\'OIDC', () => expect(new Set([COOKIE_SAML, COOKIE_SUITE, 'veridian-federation']).size).toBe(3));
it('SUITE_S : une minute au plus', () => expect(SUITE_S).toBeLessThanOrEqual(60));
it('entiteSp : une entité par organisation, sous notre adresse', () => expect(entiteSp({ tenantId: 'A' }, BASE)).toBe('https://hub.test/saml/A'));
it('scellerSuite : illisible sans notre clé', () => expect(scellerSuite({ t: 'federation', idp: 'i', state: 's', nonce: '', verifier: '', exp: 9 }, { sub: 'sub-visible', email: null, emailNie: true, nom: null })).not.toContain('sub-visible'));

describe('la suite scellée', () => {
  const t = { t: 'federation' as const, idp: 'i', state: 's', nonce: '', verifier: '', exp: 1_100 };
  const x = { sub: 'sub-1', email: null, emailNie: true as const, nom: null };
  it('sert 60 s, dans la vie de sa transaction, et ne se forge pas', () => {
    const c = scellerSuite(t, x, 1_000_000);
    expect(ouvrirSuite(c, 1_030_000)).toEqual({ transaction: t, identite: x });
    expect([ouvrirSuite(c, 1_061_000), ouvrirSuite(undefined), ouvrirSuite('v1.a.b.c'), ouvrirSuite(`${c.slice(0, -3)}AAA`, 1_030_000), ouvrirSuite(scellerSuite({ ...t, exp: 1_010 }, x, 1_000_000), 1_020_000)]).toEqual([null, null, null, null, null]);
  });
});
