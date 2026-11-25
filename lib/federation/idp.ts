/**
 * Fournisseur d'identité d'une organisation (VER-227 S2, ADR-034, D1). Posé par un opérateur seulement : c'est NOUS qui disons quels domaines il peut
 * affirmer (M3). Le secret est chiffré au repos, jamais rendu. Un domaine n'appartient qu'à une organisation ; un domaine public, à aucune.
 */
import { X509Certificate } from 'node:crypto';

import type { PrismaClient, TenantIdp } from '@prisma/client';
import { z } from 'zod';

import { estPrivee } from '@/lib/auth/ip-client';
import { chiffrer, dechiffrer } from '@/lib/ia/coffre';
import { estDeTest } from '@/lib/tenants/marque-test';

/** Boîtes ouvertes à tous : les affirmer donnerait à un client les comptes de n'importe qui. */
export const DOMAINES_PUBLICS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com', 'yahoo.com', 'yahoo.fr', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'bbox.fr', 'neuf.fr', 'gmx.com', 'gmx.fr', 'proton.me', 'protonmail.com']);
/** Nos propres domaines : les affirmer donnerait l'administration de la plateforme. `e2e.` n'a pas de compte réel. */
const DOMAINES_VERIDIAN = /(^|\.)veridian\.site$/;

const Domaine = z.string().trim().toLowerCase().max(253).regex(/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/);
export const ReglageIdp = z.strictObject({
  issuer: z.string().url().max(300),
  client_id: z.string().min(1).max(300),
  client_secret: z.string().min(1).max(1_000),
  /** Vide : il n'affirme aucune adresse, chacun relie son identité lui-même (lib/federation/liaison.ts). */
  domaines: z.array(Domaine).max(20),
  creation_auto: z.boolean().default(false),
  actif: z.boolean().default(true),
}).refine((r) => !r.creation_auto || r.domaines.length > 0, { message: 'creation_auto_sans_domaine' });
export type Reglage = z.infer<typeof ReglageIdp>;

/** SAML (VER-227) : n'affirme aucune adresse. Rien à chiffrer, la clé du fournisseur est publique. */
export const ReglageSaml = z.strictObject({
  protocole: z.literal('saml'),
  issuer: z.string().trim().min(3).max(300),
  sso_url: z.string().url().max(500),
  certificat: z.string().trim().min(100).max(10_000),
  actif: z.boolean().default(true),
});
export type RegleSaml = z.infer<typeof ReglageSaml>;
export const Alias = z.string().regex(/^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/);

/** La clé publique du fournisseur, en PEM, lisible, encore valable. Null : pas un certificat, ou fini. */
export function certificatLu(texte: string, now = Date.now()): string | null {
  try {
    const nu = texte.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(nu)) return null;
    const c = new X509Certificate(Buffer.from(nu, 'base64'));
    return new Date(c.validTo).getTime() > now ? c.toString() : null;
  } catch {
    return null;
  }
}

export type RefusIdp = 'certificat_refuse' | 'alias_pris' | 'pose_par_veridian' | 'essai_manquant' | 'absent' | 'tenant_introuvable' | 'issuer_refuse' | 'domaine_public' | 'domaine_veridian' | 'domaine_pris';
type Db = Pick<PrismaClient, 'tenant' | 'tenantIdp'>;

/** HTTPS vers un nom public. Une adresse privée du tailnet, en clair, seulement pour une organisation MARQUÉE de test (IdP jetable d'épreuve). */
export function issuerAccepte(issuer: string, test: boolean): boolean {
  let u: URL;
  try { u = new URL(issuer); } catch { return false; }
  if (u.username || u.password || u.search || u.hash) return false;
  const ip = /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':');
  if (u.protocol === 'https:' && !ip && u.hostname.includes('.') && !/\.(local|internal|localhost)$/.test(u.hostname)) return true;
  return test && u.protocol === 'http:' && /^100\.\d+\.\d+\.\d+$/.test(u.hostname) && estPrivee(u.hostname);
}

/** Les adresses que le fournisseur publie lui-même (jeton, clés, autorisation) : l'administrateur du client les écrit, elles ne visent pas chez nous. */
export const adresseAcceptee = (adresse: string | undefined, test: boolean): boolean => {
  if (!adresse) return false;
  try {
    const u = new URL(adresse);
    return issuerAccepte(`${u.protocol}//${u.host}${u.pathname}`, test) && !u.username && !u.password;
  } catch {
    return false;
  }
};

type Pose = { tenantId: string; reglage: Reglage | RegleSaml; acteur: string; /** Par le propriétaire : aucune adresse affirmée, inactif jusqu'à l'essai. */ libreService?: boolean; alias?: string | null };

export async function poserIdp(db: Db, d: Pose): Promise<{ id: string } | { refus: RefusIdp }> {
  const t = await db.tenant.findFirst({ where: { id: d.tenantId, deletedAt: null }, select: { metadata: true } });
  if (!t) return { refus: 'tenant_introuvable' };
  const test = estDeTest(t.metadata);
  const saml = 'protocole' in d.reglage ? d.reglage : null;
  const oidc = saml ? null : (d.reglage as Reglage);
  // En SAML, seul le navigateur va chez le fournisseur ; l'émetteur n'y est qu'un nom.
  if (!issuerAccepte(saml ? saml.sso_url.split('?')[0] : d.reglage.issuer, test)) return { refus: 'issuer_refuse' };
  const certificat = saml ? certificatLu(saml.certificat) : null;
  if (saml && !certificat) return { refus: 'certificat_refuse' };
  // Un propriétaire n'affirme jamais d'adresse : chacun relie son identité lui-même. Un domaine se pose chez nous, après preuve.
  const domaines = saml || d.libreService ? [] : Array.from(new Set(oidc!.domaines));
  if (domaines.some((x) => DOMAINES_PUBLICS.has(x))) return { refus: 'domaine_public' };
  // Une épreuve a besoin des comptes de batterie, qui sont chez nous : organisation marquée seulement, et résolution bornée à ces comptes.
  if (domaines.some((x) => DOMAINES_VERIDIAN.test(x)) && !test) return { refus: 'domaine_veridian' };
  if (await db.tenantIdp.findFirst({ where: { domaines: { hasSome: domaines }, actif: true, NOT: { tenantId: d.tenantId } }, select: { id: true } })) return { refus: 'domaine_pris' };
  const avant = await db.tenantIdp.findUnique({ where: { tenantId: d.tenantId }, select: { id: true, issuer: true, libreService: true, protocole: true } });
  if (d.libreService && avant && !avant.libreService) return { refus: 'pose_par_veridian' };
  if (d.alias && ((await db.tenantIdp.findFirst({ where: { alias: d.alias, NOT: { tenantId: d.tenantId } }, select: { id: true } })) || (await db.tenant.findFirst({ where: { slug: d.alias, NOT: { id: d.tenantId } }, select: { id: true } })))) return { refus: 'alias_pris' };
  const ligne = {
    // Un émetteur SAML est un nom, comparé à l'identique ; une adresse OIDC s'écrit sans barre finale.
    issuer: saml ? saml.issuer : d.reglage.issuer.replace(/\/+$/, ''), clientId: oidc?.client_id ?? '', secretChiffre: chiffrer(oidc?.client_secret ?? ''), domaines, creationAuto: !d.libreService && (oidc?.creation_auto ?? false),
    protocole: saml ? 'saml' : 'oidc', samlSsoUrl: saml?.sso_url ?? null, samlCertificat: certificat, libreService: d.libreService ?? false, essaiLe: null, actif: !d.libreService && d.reglage.actif, posePar: d.acteur, poseLe: new Date(),
    ...(d.alias === undefined ? {} : { alias: d.alias }),
  };
  // Un autre fournisseur est une autre identité : ses `sub` ne valent rien chez lui, la ligne repart d'un id neuf.
  if (avant && (avant.issuer !== ligne.issuer || (avant.protocole ?? 'oidc') !== ligne.protocole)) await db.tenantIdp.delete({ where: { id: avant.id } });
  const r = await db.tenantIdp.upsert({ where: { tenantId: d.tenantId }, create: { tenantId: d.tenantId, ...ligne }, update: ligne });
  return { id: r.id };
}

/** Ce qui se montre : jamais le secret. */
export const vueIdp = (i: TenantIdp) => ({ id: i.id, issuer: i.issuer, client_id: i.clientId, domaines: i.domaines, creation_auto: i.creationAuto, actif: i.actif, pose_le: i.poseLe.toISOString(), protocole: i.protocole ?? 'oidc', sso_url: i.samlSsoUrl ?? null, libre_service: i.libreService ?? false, essai_le: i.essaiLe?.toISOString() ?? null, alias: i.alias ?? null });

export type IdpPret = { id: string; tenantId: string; issuer: string; clientId: string; secret: string; domaines: string[]; creationAuto: boolean; test: boolean; protocole?: 'oidc' | 'saml'; saml?: { ssoUrl: string; certificat: string } };

/** Le fournisseur actif d'une organisation vivante, par son slug, son alias ou son id de fournisseur. Null : rien à en dire. `essai` : même inactif, pour l'essayer. */
export async function idpPret(db: Db, d: { slug: string } | { id: string }, env: NodeJS.ProcessEnv = process.env, essai = false): Promise<IdpPret | null> {
  const t = 'slug' in d ? await db.tenant.findFirst({ where: { slug: d.slug, deletedAt: null }, select: { id: true, status: true, metadata: true } }) : null;
  const i = await db.tenantIdp.findUnique({ where: 'slug' in d ? (t ? { tenantId: t.id } : { alias: d.slug }) : { id: d.id } });
  if (!i || (!i.actif && !essai)) return null;
  const org = t ?? (await db.tenant.findFirst({ where: { id: i.tenantId, deletedAt: null }, select: { id: true, status: true, metadata: true } }));
  if (!org || org.status === 'suspended' || org.status === 'deleted') return null;
  const test = estDeTest(org.metadata);
  // Relu à chaque usage : la marque de test tombe en 24 h, et avec elle l'adresse privée et nos domaines.
  const saml = i.protocole === 'saml';
  if (saml && !(i.samlSsoUrl && i.samlCertificat && certificatLu(i.samlCertificat))) return null;
  if (!issuerAccepte(saml ? i.samlSsoUrl!.split('?')[0] : i.issuer, test) || (!test && i.domaines.some((x) => DOMAINES_VERIDIAN.test(x)))) return null;
  return { id: i.id, tenantId: i.tenantId, issuer: i.issuer, clientId: i.clientId, secret: dechiffrer(i.secretChiffre, env), domaines: i.domaines, creationAuto: i.creationAuto, test, ...(saml ? { protocole: 'saml' as const, saml: { ssoUrl: i.samlSsoUrl!, certificat: i.samlCertificat! } } : { protocole: 'oidc' as const }) };
}

/** Le fournisseur d'une organisation, à essayer par son propriétaire avant de l'activer. */
export async function idpEssai(db: Db, tenantId: string): Promise<IdpPret | null> {
  const i = await db.tenantIdp.findUnique({ where: { tenantId }, select: { id: true, libreService: true } });
  return i?.libreService ? idpPret(db, { id: i.id }, process.env, true) : null;
}

/** Activer après essai, couper, retirer : le propriétaire, sur ce qu'il a posé lui-même. Couper ferme la porte aussitôt, retirer oublie aussi les liens. */
export async function reglerIdpLibre(db: Db & Pick<PrismaClient, 'account'>, tenantId: string, geste: 'activer' | 'couper' | 'retirer'): Promise<{ ok: true } | { refus: RefusIdp }> {
  const i = await db.tenantIdp.findUnique({ where: { tenantId }, select: { id: true, libreService: true, essaiLe: true } });
  if (!i) return { refus: 'absent' };
  if (!i.libreService) return { refus: 'pose_par_veridian' };
  if (geste === 'activer' && !i.essaiLe) return { refus: 'essai_manquant' };
  if (geste === 'retirer') {
    await db.account.deleteMany({ where: { provider: `org:${i.id}` } });
    await db.tenantIdp.delete({ where: { id: i.id } });
  } else {
    await db.tenantIdp.update({ where: { id: i.id }, data: { actif: geste === 'activer' } });
  }
  return { ok: true };
}
