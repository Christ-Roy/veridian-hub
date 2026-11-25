/**
 * Anti-boucle des événements (INTEGRATIONS-NATIVES §2.4, points 4 et 5). Les points 1 à 3 (un champ un maître, empreinte d'écho, auteur) sont
 * ceux de la cible. Ici : la chaîne bornée, et le disjoncteur par lien, qui met la paire en pause visible jusqu'à un geste humain.
 */
import { createHash } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { roleAuHub } from '@/lib/delegation/interrupteur';

type Db = Pick<PrismaClient, 'integrationLien' | 'integrationPause' | 'integrationPaire' | 'auditLog' | 'tenant' | 'tenantMember'>;
const CHAINE_MAX = 3;
const ECRITURES_MAX = 5;
const FENETRE_MS = 10 * 60_000;

/** Chaîne = les causes de l'événement, chacune `<paire>:<id>` : refusée si elle passe déjà par cette paire, ou compte plus de 3 maillons. */
export const chaineAcceptable = (chaine: readonly string[], paire: string): boolean => chaine.length <= CHAINE_MAX && !chaine.some((m) => m.split(':')[0] === paire);

/** Empreinte du contact : le lien se compte par personne, sans garder son adresse. */
export const objetDuLien = (email: string): string => createHash('sha256').update(`lien:${email}`).digest('hex').slice(0, 24);

/** `pause` si la paire est déjà coupée, ou si ce lien a déjà reçu 5 écritures en 10 min (la 6e met la paire en pause, visible dans derniere_erreur des Liaisons). */
export async function disjoncteur(db: Db, d: { tenantId: string; paire: string; objetSource: string }, now = Date.now()): Promise<'ok' | 'pause'> {
  if (await db.integrationPause.findUnique({ where: { tenantId_paire: { tenantId: d.tenantId, paire: d.paire } } })) return 'pause';
  const n = await db.integrationLien.count({ where: { tenantId: d.tenantId, paire: d.paire, objetSource: d.objetSource, ecritLe: { gt: new Date(now - FENETRE_MS) } } });
  if (n < ECRITURES_MAX) return 'ok';
  const motif = `disjoncteur : plus de ${ECRITURES_MAX} écritures en 10 min sur un même lien`;
  await db.integrationPause.upsert({ where: { tenantId_paire: { tenantId: d.tenantId, paire: d.paire } }, create: { tenantId: d.tenantId, paire: d.paire, motif }, update: {} });
  await db.integrationPaire.updateMany({ where: { tenantId: d.tenantId, paire: d.paire }, data: { derniereErreur: 'pause_disjoncteur' } }).catch(() => undefined);
  await writeAuditLog(db as PrismaClient, { action: 'integration.pause', actor: 'hub:evenements', targetType: 'tenant', targetId: d.tenantId, payload: { paire: d.paire, motif } });
  return 'pause';
}

export async function noterEcriture(db: Pick<Db, 'integrationLien'>, d: { tenantId: string; paire: string; objetSource: string; evenementId: string }, now = Date.now()): Promise<void> {
  await db.integrationLien.create({ data: { ...d, ecritLe: new Date(now) } });
  await db.integrationLien.deleteMany({ where: { ecritLe: { lt: new Date(now - 24 * 3_600_000) } } }).catch(() => undefined);
}

/** Le geste humain : propriétaire ou admin, relu au Hub. Rien ne se rallume seul. */
export async function leverPause(db: Db, d: { tenantId: string; paire: string; hubUserId: string }): Promise<boolean> {
  const role = await roleAuHub(db, d.tenantId, d.hubUserId);
  if (role !== 'owner' && role !== 'admin') return false;
  const r = await db.integrationPause.deleteMany({ where: { tenantId: d.tenantId, paire: d.paire } });
  if (r.count === 0) return false;
  await db.integrationPaire.updateMany({ where: { tenantId: d.tenantId, paire: d.paire, derniereErreur: 'pause_disjoncteur' }, data: { derniereErreur: null } }).catch(() => undefined);
  await writeAuditLog(db as PrismaClient, { action: 'integration.pause_levee', actor: `user:${d.hubUserId}`, targetType: 'tenant', targetId: d.tenantId, payload: { paire: d.paire } });
  return true;
}
