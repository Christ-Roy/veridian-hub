/**
 * Fournisseur d'identité d'une organisation (VER-227 S2, ADR-034, D1). Posé par un opérateur seulement : c'est NOUS qui disons quels domaines il peut
 * affirmer (M3). Le secret est chiffré au repos, jamais rendu. Un domaine n'appartient qu'à une organisation ; un domaine public, à aucune.
 */
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
export type RefusIdp = 'tenant_introuvable' | 'issuer_refuse' | 'domaine_public' | 'domaine_veridian' | 'domaine_pris';
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

export async function poserIdp(db: Db, d: { tenantId: string; reglage: Reglage; acteur: string }): Promise<{ id: string } | { refus: RefusIdp }> {
  const t = await db.tenant.findFirst({ where: { id: d.tenantId, deletedAt: null }, select: { metadata: true } });
  if (!t) return { refus: 'tenant_introuvable' };
  const test = estDeTest(t.metadata);
  if (!issuerAccepte(d.reglage.issuer, test)) return { refus: 'issuer_refuse' };
  const domaines = Array.from(new Set(d.reglage.domaines));
  if (domaines.some((x) => DOMAINES_PUBLICS.has(x))) return { refus: 'domaine_public' };
  // Une épreuve a besoin des comptes de batterie, qui sont chez nous : organisation marquée seulement, et résolution bornée à ces comptes.
  if (domaines.some((x) => DOMAINES_VERIDIAN.test(x)) && !test) return { refus: 'domaine_veridian' };
  if (await db.tenantIdp.findFirst({ where: { domaines: { hasSome: domaines }, actif: true, NOT: { tenantId: d.tenantId } }, select: { id: true } })) return { refus: 'domaine_pris' };
  const ligne = { issuer: d.reglage.issuer.replace(/\/+$/, ''), clientId: d.reglage.client_id, secretChiffre: chiffrer(d.reglage.client_secret), domaines, creationAuto: d.reglage.creation_auto, actif: d.reglage.actif, posePar: d.acteur, poseLe: new Date() };
  const avant = await db.tenantIdp.findUnique({ where: { tenantId: d.tenantId }, select: { id: true, issuer: true } });
  // Un autre fournisseur est une autre identité : ses `sub` ne valent rien chez lui, la ligne repart d'un id neuf.
  if (avant && avant.issuer !== ligne.issuer) await db.tenantIdp.delete({ where: { id: avant.id } });
  const r = await db.tenantIdp.upsert({ where: { tenantId: d.tenantId }, create: { tenantId: d.tenantId, ...ligne }, update: ligne });
  return { id: r.id };
}

/** Ce qui se montre : jamais le secret. */
export const vueIdp = (i: TenantIdp) => ({ id: i.id, issuer: i.issuer, client_id: i.clientId, domaines: i.domaines, creation_auto: i.creationAuto, actif: i.actif, pose_le: i.poseLe.toISOString() });

export type IdpPret = { id: string; tenantId: string; issuer: string; clientId: string; secret: string; domaines: string[]; creationAuto: boolean; test: boolean };

/** Le fournisseur actif d'une organisation vivante, par son slug ou son id de fournisseur. Null : rien à en dire. */
export async function idpPret(db: Db, d: { slug: string } | { id: string }, env: NodeJS.ProcessEnv = process.env): Promise<IdpPret | null> {
  const t = 'slug' in d ? await db.tenant.findFirst({ where: { slug: d.slug, deletedAt: null }, select: { id: true, status: true, metadata: true } }) : null;
  if ('slug' in d && !t) return null;
  const i = await db.tenantIdp.findUnique({ where: 'slug' in d ? { tenantId: t!.id } : { id: d.id } });
  if (!i?.actif) return null;
  const org = t ?? (await db.tenant.findFirst({ where: { id: i.tenantId, deletedAt: null }, select: { id: true, status: true, metadata: true } }));
  if (!org || org.status === 'suspended' || org.status === 'deleted') return null;
  const test = estDeTest(org.metadata);
  // Relu à chaque usage : la marque de test tombe en 24 h, et avec elle l'adresse privée et nos domaines.
  if (!issuerAccepte(i.issuer, test) || (!test && i.domaines.some((x) => DOMAINES_VERIDIAN.test(x)))) return null;
  return { id: i.id, tenantId: i.tenantId, issuer: i.issuer, clientId: i.clientId, secret: dechiffrer(i.secretChiffre, env), domaines: i.domaines, creationAuto: i.creationAuto, test };
}
