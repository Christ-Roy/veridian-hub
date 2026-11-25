/**
 * Le dialogue SAML 2.0 avec le fournisseur d'une organisation (VER-227). Même garde que l'OIDC : la transaction vit 10 min dans un cookie scellé du
 * navigateur qui l'a ouverte, la réponse doit répondre à CETTE demande, viser CETTE organisation, être signée par SA clé, en SHA-256. Rien n'est cru
 * sur l'adresse : seul compte un identifiant durable. Signature, dates, audience, émetteur et demande : `@node-saml/node-saml`.
 */
import { randomBytes } from 'node:crypto';

import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { z } from 'zod';

import { chiffrer, dechiffrer } from '@/lib/ia/coffre';

import type { IdpPret } from './idp';
import { sceller, Transaction, TRANSACTION_S, type Identite } from './oidc';

export const COOKIE_SAML = 'veridian-federation-saml';
/** Où le fournisseur poste sa réponse, pour toutes les organisations ; l'audience, elle, est propre à chacune. */
export const CHEMIN_ACS = '/api/auth/federation/saml';
/** L'identité vérifiée, entre la réponse postée (où le cookie de session n'est pas envoyé) et la suite. */
export const COOKIE_SUITE = 'veridian-federation-saml-suite';
export const CHEMIN_SUITE = '/api/auth/federation/saml/suite';
const MAX_XML = 200_000;

/** L'audience de cette organisation : une réponse faite pour une autre ne vaut rien ici. */
export const entiteSp = (i: Pick<IdpPret, 'tenantId'>, base: URL): string => new URL(`/saml/${i.tenantId}`, base).href;

function client(i: IdpPret, base: URL, demande: string): SAML {
  if (!i.saml) throw new Error('saml_incomplet');
  return new SAML({
    issuer: entiteSp(i, base),
    audience: entiteSp(i, base),
    callbackUrl: new URL(CHEMIN_ACS, base).href,
    entryPoint: i.saml.ssoUrl,
    idpIssuer: i.issuer,
    idpCert: i.saml.certificat,
    identifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    disableRequestedAuthnContext: true,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
    acceptedClockSkewMs: 30_000,
    maxAssertionAgeMs: 5 * 60_000,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: TRANSACTION_S * 1000,
    generateUniqueId: () => demande,
    // La seule demande connue est celle du cookie : rien d'autre ne répond.
    cacheProvider: {
      saveAsync: async (cle, valeur) => ({ value: valeur, createdAt: Date.now() }),
      getAsync: async (cle) => (cle === demande ? new Date().toISOString() : null),
      removeAsync: async (cle) => cle,
    },
  });
}

export async function demarrerSaml(i: IdpPret, base: URL, o: { relier?: { userId: string }; essai?: { userId: string }; prouver?: { userId: string } } = {}, now = Date.now()): Promise<{ url: string; cookie: string }> {
  const demande = `_${randomBytes(20).toString('hex')}`;
  const url = await client(i, base, demande).getAuthorizeUrlAsync('', undefined, {});
  return { url, cookie: sceller({ idp: i.id, state: demande, nonce: '', verifier: '', exp: Math.floor(now / 1000) + TRANSACTION_S, ...o }) };
}

/** Ce qu'on ne laisse pas à l'analyseur : entités, commentaires (ils coupent un identifiant en deux), plusieurs assertions, SHA-1. */
export function refusXml(xml: string): string | null {
  if (xml.length > MAX_XML) return 'trop_gros';
  if (/<!DOCTYPE|<!ENTITY|<!--|<\?xml-stylesheet/i.test(xml)) return 'xml_refuse';
  if ((xml.match(/<(?:[\w.-]+:)?Assertion[\s>]/g) ?? []).length !== 1) return 'assertions';
  if (/<(?:[\w.-]+:)?EncryptedAssertion[\s>]/.test(xml)) return 'chiffree';
  if (/xmldsig#(rsa-sha1|sha1|dsa-sha1|hmac-sha1)/.test(xml)) return 'sha1';
  return null;
}

const OID_MICROSOFT = 'http://schemas.microsoft.com/identity/claims/objectidentifier';

/** Un identifiant qui désigne la MÊME personne demain : jamais une adresse (elle se recycle), jamais un identifiant d'un jour. */
export function identifiantDurable(p: { issuer?: string; nameID?: string; nameIDFormat?: string; attributes?: Record<string, unknown> }): string | null {
  const oid = p.attributes?.[OID_MICROSOFT];
  const sub = /^https:\/\/sts\.windows\.net\//.test(p.issuer ?? '') && typeof oid === 'string' ? oid : p.nameID;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > 255 || sub.includes('@')) return null;
  return sub === p.nameID && /transient|emailAddress/i.test(p.nameIDFormat ?? '') ? null : sub;
}

export async function terminerSaml(i: IdpPret, t: Transaction, reponse: string, base: URL): Promise<Identite> {
  if (reponse.length > MAX_XML * 1.5) throw new Error('trop_gros');
  const refus = refusXml(Buffer.from(reponse, 'base64').toString('utf8'));
  if (refus) throw new Error(refus);
  const { profile } = await client(i, base, t.state).validatePostResponseAsync({ SAMLResponse: reponse });
  if (!profile || profile.issuer !== i.issuer) throw new Error('emetteur');
  const sub = identifiantDurable(profile as never);
  if (!sub) throw new Error('identifiant_non_durable');
  return { sub, email: null, emailNie: true, nom: null };
}

const Suite = z.object({ t: z.literal('saml-suite'), exp: z.number(), transaction: Transaction, identite: z.object({ sub: z.string().min(1).max(255), email: z.null(), emailNie: z.literal(true), nom: z.null() }) });
export const SUITE_S = 60;
export const scellerSuite = (transaction: Transaction, identite: Identite, now = Date.now()): string => chiffrer(JSON.stringify({ t: 'saml-suite', exp: Math.floor(now / 1000) + SUITE_S, transaction, identite }));
export function ouvrirSuite(scelle: string | undefined, now = Date.now()): { transaction: Transaction; identite: Identite } | null {
  if (!scelle) return null;
  try {
    const x = Suite.parse(JSON.parse(dechiffrer(scelle)));
    return x.exp * 1000 > now && x.transaction.exp * 1000 > now ? { transaction: x.transaction, identite: x.identite } : null;
  } catch {
    return null;
  }
}
