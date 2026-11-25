/**
 * Interrupteurs des paires d'apps dans une organisation (VER-245 b.2). Par défaut selon lib/delegation/etat.ts (25/11) ; un propriétaire ou un admin coupe, la
 * coupure tient ; rallumer ce qui n'a jamais été consenti, et tout élargissement de portée, demandent le clic du propriétaire sur une page du Hub.
 * Aucun mail d'avis : l'état vit dans le Hub et dans les apps.
 */
import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';

import { contexteDe, etatDe } from './etat';
import { organisationDeTest } from './ouverture';
import { empreintePortees, paire as trouverPaire, paireReglable, PAIRES } from './paires';
import { empreinte } from './poignee';

const DEMANDE_MIN = 15;
type Db = Pick<PrismaClient, 'organisation' | 'integrationPaire' | 'integrationDemande' | 'tenant' | 'tenantMember' | 'user' | 'auditLog'>;
export type EtatPaire = { paire: string; libelle: string; source: string; cible: string; nature: string; etat: 'allumee' | 'eteinte' | 'indisponible'; consentie: boolean; par_defaut: boolean; change_par: string | null; change_le: string | null; dernier_passage: string | null; derniere_erreur: string | null };
export type Reglage = { etat: 'allumee' | 'eteinte' } | { etat: 'a_confirmer'; lien: string; expire_le: string } | { refus: 'paire_inconnue' | 'role_insuffisant' | 'cible_non_servie' };

export async function listerIntegrations(db: Pick<Db, 'integrationPaire' | 'user' | 'tenant' | 'organisation'>, tenantId: string, env: NodeJS.ProcessEnv = process.env): Promise<EtatPaire[]> {
  const lignes = await db.integrationPaire.findMany({ where: { tenantId } });
  const test = await organisationDeTest(db, tenantId, env);
  const contexte = await contexteDe(db, tenantId);
  const ids = Array.from(new Set(lignes.map((l) => l.changePar.split(' ')[0])));
  const comptes = ids.length ? await db.user.findMany({ where: { supabaseUserId: { in: ids } }, select: { supabaseUserId: true, email: true } }) : [];
  const qui = (c: string) => {
    const [id, ...via] = c.split(' ');
    return [comptes.find((u) => u.supabaseUserId === id)?.email ?? 'compte inconnu', ...via].join(' ');
  };
  return PAIRES.map((p) => {
    const l = lignes.find((x) => x.paire === p.cle);
    const e = etatDe(p, l, contexte, paireReglable(p, tenantId, env, test));
    const reglee = l && l.etat !== 'defaut' ? l : null;
    return {
      paire: p.cle, libelle: p.libelle, source: p.source, cible: p.cible, nature: p.nature,
      etat: e.etat, consentie: e.consentie, par_defaut: e.parDefaut,
      change_par: reglee ? qui(reglee.changePar) : null,
      change_le: reglee?.changeLe.toISOString() ?? null,
      dernier_passage: l?.dernierPassage?.toISOString() ?? null,
      derniere_erreur: l?.derniereErreur ?? null,
    };
  });
}

/** Rôle relu au Hub, jamais reçu de l'appelant. */
export async function roleAuHub(db: Pick<Db, 'tenant' | 'tenantMember'>, tenantId: string, hubUserId: string): Promise<'owner' | 'admin' | 'member' | null> {
  const t = await db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { userId: true, status: true } });
  if (!t || t.status === 'suspended' || t.status === 'deleted') return null;
  if (t.userId === hubUserId) return 'owner';
  const m = await db.tenantMember.findUnique({ where: { tenantId_userId: { tenantId, userId: hubUserId } } });
  return !m || m.deletedAt ? null : m.role === 'owner' || m.role === 'admin' ? m.role : 'member';
}

export async function reglerIntegration(db: Db, d: { tenantId: string; paire: string; etat: 'allumee' | 'eteinte'; hubUserId: string; client: string; origine: string }, env: NodeJS.ProcessEnv = process.env): Promise<Reglage> {
  const p = trouverPaire(d.paire);
  if (!p) return { refus: 'paire_inconnue' };
  const role = await roleAuHub(db, d.tenantId, d.hubUserId);
  if (role !== 'owner' && role !== 'admin') return { refus: 'role_insuffisant' };
  const cle = { tenantId_paire: { tenantId: d.tenantId, paire: p.cle } };
  const changePar = `${d.hubUserId} via ${d.client}`.slice(0, 200);
  const l = await db.integrationPaire.findUnique({ where: cle });
  if (d.etat === 'allumee') {
    if (!paireReglable(p, d.tenantId, env, await organisationDeTest(db, d.tenantId, env))) return { refus: 'cible_non_servie' };
    // Active par défaut : elle l'est déjà, rien à écrire ni à faire confirmer.
    if (etatDe(p, l, await contexteDe(db, d.tenantId), true).parDefaut) return { etat: 'allumee' };
    if (!l?.consentiLe || l.portees !== empreintePortees(p)) {
      const jeton = randomBytes(32).toString('base64url');
      const expireLe = new Date(Date.now() + DEMANDE_MIN * 60_000);
      await db.integrationDemande.create({ data: { empreinte: empreinte(jeton), tenantId: d.tenantId, paire: p.cle, demandePar: d.hubUserId, clientNom: d.client.slice(0, 120), expireLe } });
      await writeAuditLog(db as PrismaClient, { action: 'integration.demande', actor: `user:${d.hubUserId}`, targetType: 'tenant', targetId: d.tenantId, payload: { paire: p.cle, client: d.client.slice(0, 120) } });
      return { etat: 'a_confirmer', lien: `${d.origine}/liaisons/confirmer/${jeton}`, expire_le: expireLe.toISOString() };
    }
  }
  await db.integrationPaire.upsert({ where: cle, create: { tenantId: d.tenantId, paire: p.cle, etat: d.etat, changePar }, update: { etat: d.etat, changePar, changeLe: new Date() } });
  await writeAuditLog(db as PrismaClient, { action: `integration.${d.etat}`, actor: `user:${d.hubUserId}`, targetType: 'tenant', targetId: d.tenantId, payload: { paire: p.cle, client: d.client.slice(0, 120) } });
  return { etat: d.etat };
}

export type DemandeLue = { tenantId: string; espace: string; paire: string; libelle: string; portees: readonly string[]; client: string; demandePar: string; expireLe: Date };

/** Ce que la page de confirmation montre ; null si la demande n'est plus bonne, ou n'est pas celle de CE propriétaire. */
export async function lireDemande(db: Pick<Db, 'integrationDemande' | 'tenant' | 'tenantMember' | 'user'>, jeton: string, hubUserId: string, env: NodeJS.ProcessEnv = process.env): Promise<DemandeLue | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(jeton)) return null;
  const q = await db.integrationDemande.findUnique({ where: { empreinte: empreinte(jeton) } });
  if (!q || q.confirmeLe || q.expireLe <= new Date()) return null;
  const p = trouverPaire(q.paire);
  if (!p || !paireReglable(p, q.tenantId, env, await organisationDeTest(db, q.tenantId, env))) return null;
  if ((await roleAuHub(db, q.tenantId, hubUserId)) !== 'owner') return null;
  const t = await db.tenant.findFirst({ where: { id: q.tenantId, deletedAt: null }, select: { name: true } });
  const u = await db.user.findFirst({ where: { supabaseUserId: q.demandePar }, select: { email: true } });
  return { tenantId: q.tenantId, espace: t?.name ?? '', paire: p.cle, libelle: p.libelle, portees: p.portees, client: q.clientNom, demandePar: u?.email ?? 'compte inconnu', expireLe: q.expireLe };
}

/** Le clic du propriétaire : usage unique, revérifié en entier. */
export async function confirmerDemande(db: Db, jeton: string, hubUserId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; paire: string; tenantId: string } | { ok: false }> {
  const q = await lireDemande(db, jeton, hubUserId, env);
  if (!q) return { ok: false };
  const pris = await db.integrationDemande.updateMany({ where: { empreinte: empreinte(jeton), confirmeLe: null, expireLe: { gt: new Date() } }, data: { confirmeLe: new Date() } });
  if (pris.count !== 1) return { ok: false };
  const p = trouverPaire(q.paire)!;
  const consent = { etat: 'allumee', changePar: `${hubUserId} via le Hub`, changeLe: new Date(), consentiPar: hubUserId, consentiLe: new Date(), portees: empreintePortees(p) };
  await db.integrationPaire.upsert({ where: { tenantId_paire: { tenantId: q.tenantId, paire: q.paire } }, create: { tenantId: q.tenantId, paire: q.paire, ...consent }, update: consent });
  await writeAuditLog(db as PrismaClient, { action: 'integration.consentie', actor: `user:${hubUserId}`, targetType: 'tenant', targetId: q.tenantId, payload: { paire: q.paire, client: q.client } });
  return { ok: true, paire: q.paire, tenantId: q.tenantId };
}

/** Une organisation suspendue perd ses consentements : la reprise ne rallume rien toute seule. */
export async function couperIntegrations(db: Pick<PrismaClient, 'integrationPaire'>, tenantId: string): Promise<number> {
  const coupe = { etat: 'eteinte', consentiLe: null, consentiPar: null, changePar: 'hub suspension', changeLe: new Date() };
  const { count } = await db.integrationPaire.updateMany({ where: { tenantId }, data: coupe });
  // Ce qui était actif par défaut s'éteint de même : sans ligne, la reprise le rallumerait.
  await db.integrationPaire.createMany({ data: PAIRES.map((p) => ({ tenantId, paire: p.cle, ...coupe })), skipDuplicates: true });
  return count;
}
