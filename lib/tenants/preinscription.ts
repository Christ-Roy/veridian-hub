/**
 * Pré-inscription d'une adresse dans une organisation (VER-227 S1, ADR-034) : la personne n'a pas encore de compte, ou pas encore prouvé son
 * adresse. Rien ne part par mail, rien n'est créé d'avance : elle rejoint l'organisation à son premier passage AVEC une adresse prouvée,
 * exactement égale, avec le rôle posé (`member` ou `admin`, jamais propriétaire). Posée par un opérateur seulement. `exemptee` : dans une organisation obligatoire,
 * elle garde son accès habituel jusqu'à son rattachement (lib/federation/obligation.ts).
 */
import type { PrismaClient } from '@prisma/client';

import { adressesProuvees } from '@/lib/adresses';
import { normaliserEmail } from '@/lib/auth/email-normalize';
import { poserExemption } from '@/lib/federation/connexion';
import { fermees, type DbObligation } from '@/lib/federation/obligation';
import { pushUserToApps } from '@/lib/identity/push-user';
import { suivreOrganisation } from '@/lib/organisations/emission';

import { RefusMembre, rejoindre, type DbMembres } from './membres';
import { pousserRole } from './roles';

export const DUREE_PREINSCRIPTION_J = 30;
type Db = DbMembres & Pick<PrismaClient, 'tenantPreinscription' | 'organisation' | 'organisationEmission' | 'userEmail'> & DbObligation;
type DbListe = Pick<PrismaClient, 'tenantPreinscription'>;
type Deps = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch };

/** Pose ou renouvelle : un geste neuf repart de zéro (délai, annulation, consommation). */
export async function preinscrire(db: DbListe, d: { tenantId: string; email: string; acteur: string; role?: 'member' | 'admin'; exemptee?: boolean }, now = new Date()): Promise<Date> {
  const email = normaliserEmail(d.email);
  const expireLe = new Date(now.getTime() + DUREE_PREINSCRIPTION_J * 86_400_000);
  const neuf = { expireLe, creePar: d.acteur, creeLe: now, consommeeLe: null, annuleeLe: null, hubUserId: null, role: d.role ?? 'member', exemptee: d.exemptee ?? false };
  await db.tenantPreinscription.upsert({ where: { tenantId_email: { tenantId: d.tenantId, email } }, create: { tenantId: d.tenantId, email, ...neuf }, update: neuf });
  return expireLe;
}

/** Annule celles qui attendent encore. Rend combien. */
export async function annulerPreinscriptions(db: DbListe, d: { tenantId: string; email: string }, now = new Date()): Promise<number> {
  return (await db.tenantPreinscription.updateMany({ where: { tenantId: d.tenantId, email: normaliserEmail(d.email), consommeeLe: null, annuleeLe: null }, data: { annuleeLe: now } })).count;
}

export type Preinscrit = { email: string; etat: 'en_attente' | 'joint' | 'expiree' | 'annulee'; expire_le: string; joint_le: string | null; role: string; exemptee: boolean };
export async function listerPreinscriptions(db: DbListe, tenantId: string, now = new Date()): Promise<Preinscrit[]> {
  const l = await db.tenantPreinscription.findMany({ where: { tenantId }, orderBy: { email: 'asc' } });
  return l.map((p) => ({
    email: p.email,
    etat: p.consommeeLe ? 'joint' : p.annuleeLe ? 'annulee' : p.expireLe <= now ? 'expiree' : 'en_attente',
    expire_le: p.expireLe.toISOString(),
    joint_le: p.consommeeLe?.toISOString() ?? null,
    role: p.role,
    exemptee: p.exemptee,
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
      await rejoindre(db, { tenantId: p.tenantId, hubUserId, role: p.role === 'admin' ? 'admin' : 'member', origine: 'preinscription', acteur: `preinscription:${p.id}`, emiseLe: p.creeLe });
    } catch (err) {
      if (!(err instanceof RefusMembre)) throw err;
      // Suspendue : elle attend la reprise. Retiré depuis, ou organisation disparue : elle ne vaut plus rien.
      if (err.code !== 'tenant_suspendu') await db.tenantPreinscription.updateMany({ where: { id: p.id, consommeeLe: null }, data: { annuleeLe: now } });
      continue;
    }
    if (p.exemptee) await poserExemption(db, { tenantId: p.tenantId, hubUserId, nature: 'rattachement', acteur: p.creePar });
    // Ses sessions d'app suivent la personne : dans une organisation obligatoire, elles se rouvrent en passant par le Hub.
    else if ((await fermees(db, hubUserId, { par: 'personne' })).some((f) => f.tenantId === p.tenantId)) await pushUserToApps({ hubUserId, revokeSessions: true }, { fetchImpl: deps.fetchImpl }).catch((err) => console.error('[preinscription] sessions', err instanceof Error ? err.message.slice(0, 160) : 'erreur'));
    await suivreOrganisation(db, p.tenantId, deps);
    await pousserRole(db, { tenantId: p.tenantId, hubUserId }, deps).catch(() => undefined);
    await db.tenantPreinscription.updateMany({ where: { id: p.id, consommeeLe: null }, data: { consommeeLe: now, hubUserId } });
    jointes.push(p.tenantId);
  }
  return jointes;
}
