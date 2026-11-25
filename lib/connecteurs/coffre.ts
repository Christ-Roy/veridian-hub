/**
 * Les connexions d'une personne à des services extérieurs (VER-119) : jetons chiffrés au repos, jamais rendus, jamais journalisés. Une connexion est à la
 * PERSONNE (`hub_user_id`), pas à l'organisation : personne d'autre ne s'en sert, et elle part avec son compte.
 */
import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { chiffrer, dechiffrer } from '@/lib/ia/coffre';
import { oublierUtilisateur } from '@/lib/mcp/cache';

import { renouveler, revoquer, type Deps, type Jetons } from './oauth';
import { connecteur, CONNECTEURS, type Connecteur } from './registre';

type Db = Pick<PrismaClient, 'connecteurClient' | 'connexionExterne' | 'auditLog'>;
/** Un jeton qui finit dans la minute est déjà fini. */
const MARGE_MS = 60_000;

export async function garder(db: Db, hubUserId: string, cle: string, j: Jetons, now = new Date()): Promise<void> {
  const ligne = { accesChiffre: chiffrer(j.acces), refreshChiffre: j.refresh ? chiffrer(j.refresh) : null, expireLe: j.expireLe, etat: 'active', renouveleLe: now };
  await db.connexionExterne.upsert({ where: { hubUserId_connecteur: { hubUserId, connecteur: cle } }, create: { hubUserId, connecteur: cle, ...ligne }, update: { ...ligne, creeLe: now } });
  oublierUtilisateur(hubUserId, cle);
  await writeAuditLog(db as PrismaClient, { action: 'connecteur.branche', actor: `user:${hubUserId}`, targetType: 'user', targetId: hubUserId, payload: { connecteur: cle } });
}

export type EtatConnexion = { cle: string; nom: string; texte: string; etat: 'absente' | 'active' | 'a_rebrancher'; depuis: string | null };
export async function connexionsDe(db: Pick<PrismaClient, 'connexionExterne'>, hubUserId: string): Promise<EtatConnexion[]> {
  const l = await db.connexionExterne.findMany({ where: { hubUserId }, select: { connecteur: true, etat: true, creeLe: true } });
  return CONNECTEURS.map((c) => {
    const x = l.find((y) => y.connecteur === c.cle);
    return { cle: c.cle, nom: c.nom, texte: c.texte, etat: !x ? 'absente' : x.etat === 'active' ? 'active' : 'a_rebrancher', depuis: x?.creeLe.toISOString() ?? null };
  });
}

/** Un seul renouvellement à la fois par connexion : le service tourne souvent le jeton, deux renouvellements le perdraient. */
const enCours = new Map<string, Promise<string | null>>();

/** Le jeton d'accès valable, renouvelé s'il le faut. Null : à rebrancher, ou absente. `force` : le service vient de le refuser. */
export async function jetonDe(db: Db, hubUserId: string, c: Connecteur, retour: string, d: Deps & { force?: boolean } = {}): Promise<string | null> {
  const now = d.now ?? Date.now();
  const l = await db.connexionExterne.findUnique({ where: { hubUserId_connecteur: { hubUserId, connecteur: c.cle } } });
  if (!l || l.etat !== 'active') return null;
  if (!d.force && (!l.expireLe || l.expireLe.getTime() - MARGE_MS > now)) return dechiffrer(l.accesChiffre);
  const k = `${hubUserId}:${c.cle}`;
  const deja = enCours.get(k);
  if (deja) return deja;
  const p = (async () => {
    const aRebrancher = async () => {
      // Seulement si personne d'autre (l'autre version, pendant une bascule) ne l'a renouvelée entre-temps.
      const { count } = await db.connexionExterne.updateMany({ where: { id: l.id, accesChiffre: l.accesChiffre }, data: { etat: 'a_rebrancher' } });
      if (count) return null;
      const r = await db.connexionExterne.findUnique({ where: { id: l.id } });
      return r?.etat === 'active' ? dechiffrer(r.accesChiffre) : null;
    };
    if (!l.refreshChiffre) return aRebrancher();
    try {
      const j = await renouveler(db, c, dechiffrer(l.refreshChiffre), retour, d);
      await db.connexionExterne.updateMany({ where: { id: l.id }, data: { accesChiffre: chiffrer(j.acces), refreshChiffre: j.refresh ? chiffrer(j.refresh) : null, expireLe: j.expireLe, renouveleLe: new Date(now) } });
      return j.acces;
    } catch (err) {
      // Refusé par le service : à rebrancher. Injoignable : on ne conclut rien, le prochain appel réessaie.
      const refuse = (err as { error?: string }).error === 'invalid_grant' || (err as { error?: string }).error === 'invalid_client';
      console.error(JSON.stringify({ tag: '[connecteur]', level: 'error', msg: 'renouvellement', connecteur: c.cle, code: (err as { code?: string; error?: string }).error ?? (err as { code?: string }).code ?? 'erreur' }));
      if (refuse) return aRebrancher();
      throw new Error('service_injoignable');
    }
  })().finally(() => enCours.delete(k));
  enCours.set(k, p);
  return p;
}

/** Coupe : effacée chez nous quoi qu'il arrive, révoquée chez le service au mieux. */
export async function couper(db: Db, hubUserId: string, cle: string, retour: string, d: Deps = {}): Promise<{ coupee: boolean; revoquee: boolean }> {
  const c = connecteur(cle);
  const l = await db.connexionExterne.findUnique({ where: { hubUserId_connecteur: { hubUserId, connecteur: cle } } });
  if (!l) return { coupee: false, revoquee: false };
  await db.connexionExterne.deleteMany({ where: { id: l.id } });
  oublierUtilisateur(hubUserId, cle);
  const revoquee = c ? await revoquer(db, c, dechiffrer(l.refreshChiffre ?? l.accesChiffre), retour, d) : false;
  await writeAuditLog(db as PrismaClient, { action: 'connecteur.coupe', actor: `user:${hubUserId}`, targetType: 'user', targetId: hubUserId, payload: { connecteur: cle, revoquee } });
  return { coupee: true, revoquee };
}

/** Un compte supprimé n'en laisse aucune. */
export async function couperToutes(db: Db, hubUserId: string, retour: string, d: Deps = {}): Promise<number> {
  const l = await db.connexionExterne.findMany({ where: { hubUserId }, select: { connecteur: true } });
  for (const x of l) await couper(db, hubUserId, x.connecteur, retour, d);
  return l.length;
}
