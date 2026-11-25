/**
 * Pré-inscription d'une adresse dans une organisation (VER-227 S1, ADR-034) : la personne n'a pas encore de compte, ou pas encore prouvé son
 * adresse. Rien ne part par mail, rien n'est créé d'avance : elle rejoint l'organisation à son premier passage AVEC une adresse prouvée,
 * exactement égale. Toujours `member` : un rôle plus haut se pose après, par un geste nommé. Posée par un opérateur seulement.
 */
import type { PrismaClient } from '@prisma/client';

import { adressesProuvees } from '@/lib/adresses';
import { normaliserEmail } from '@/lib/auth/email-normalize';
import { suivreOrganisation } from '@/lib/organisations/emission';

import { RefusMembre, rejoindre, type DbMembres } from './membres';
import { pousserRole } from './roles';

export const DUREE_PREINSCRIPTION_J = 30;
type Db = DbMembres & Pick<PrismaClient, 'tenantPreinscription' | 'organisation' | 'organisationEmission' | 'userEmail'>;
type DbListe = Pick<PrismaClient, 'tenantPreinscription'>;
type Deps = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch };

/** Pose ou renouvelle : un geste neuf repart de zéro (délai, annulation, consommation). */
export async function preinscrire(db: DbListe, d: { tenantId: string; email: string; acteur: string }, now = new Date()): Promise<Date> {
  const email = normaliserEmail(d.email);
  const expireLe = new Date(now.getTime() + DUREE_PREINSCRIPTION_J * 86_400_000);
  const neuf = { expireLe, creePar: d.acteur, creeLe: now, consommeeLe: null, annuleeLe: null, hubUserId: null };
  await db.tenantPreinscription.upsert({ where: { tenantId_email: { tenantId: d.tenantId, email } }, create: { tenantId: d.tenantId, email, ...neuf }, update: neuf });
  return expireLe;
}

/** Annule celles qui attendent encore. Rend combien. */
export async function annulerPreinscriptions(db: DbListe, d: { tenantId: string; email: string }, now = new Date()): Promise<number> {
  return (await db.tenantPreinscription.updateMany({ where: { tenantId: d.tenantId, email: normaliserEmail(d.email), consommeeLe: null, annuleeLe: null }, data: { annuleeLe: now } })).count;
}

export type Preinscrit = { email: string; etat: 'en_attente' | 'joint' | 'expiree' | 'annulee'; expire_le: string; joint_le: string | null };
export async function listerPreinscriptions(db: DbListe, tenantId: string, now = new Date()): Promise<Preinscrit[]> {
  const l = await db.tenantPreinscription.findMany({ where: { tenantId }, orderBy: { email: 'asc' } });
  return l.map((p) => ({
    email: p.email,
    etat: p.consommeeLe ? 'joint' : p.annuleeLe ? 'annulee' : p.expireLe <= now ? 'expiree' : 'en_attente',
    expire_le: p.expireLe.toISOString(),
    joint_le: p.consommeeLe?.toISOString() ?? null,
  }));
}

/**
 * À chaque passage d'un compte : rejoint les organisations qui l'ont pré-inscrit. L'adresse prouvée est RELUE ici, jamais reçue. Rejouable :
 * la ligne n'est consommée qu'une fois l'appartenance écrite et l'app prévenue. Rend les organisations rejointes.
 */
export async function consommerPreinscriptions(db: Db, hubUserId: string, deps: Deps = {}, now = new Date()): Promise<string[]> {
  const u = await db.user.findFirst({ where: { supabaseUserId: hubUserId }, select: { id: true, email: true, emailVerified: true } });
  if (!u?.emailVerified) return [];
  // N'importe laquelle de ses adresses PROUVÉES (S1b) : celle que l'organisation connaît n'est pas toujours la principale.
  const attente = await db.tenantPreinscription.findMany({ where: { email: { in: await adressesProuvees(db, u) }, consommeeLe: null, annuleeLe: null, expireLe: { gt: now } } });
  const jointes: string[] = [];
  for (const p of attente) {
    try {
      await rejoindre(db, { tenantId: p.tenantId, hubUserId, origine: 'preinscription', acteur: `preinscription:${p.id}`, emiseLe: p.creeLe });
    } catch (err) {
      if (!(err instanceof RefusMembre)) throw err;
      // Suspendue : elle attend la reprise. Retiré depuis, ou organisation disparue : elle ne vaut plus rien.
      if (err.code !== 'tenant_suspendu') await db.tenantPreinscription.updateMany({ where: { id: p.id, consommeeLe: null }, data: { annuleeLe: now } });
      continue;
    }
    await suivreOrganisation(db, p.tenantId, deps);
    await pousserRole(db, { tenantId: p.tenantId, hubUserId }, deps).catch(() => undefined);
    await db.tenantPreinscription.updateMany({ where: { id: p.id, consommeeLe: null }, data: { consommeeLe: now, hubUserId } });
    jointes.push(p.tenantId);
  }
  return jointes;
}
