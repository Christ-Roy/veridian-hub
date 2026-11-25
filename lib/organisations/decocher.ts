/** Décocher une app réservée : ceux qui y sont entrés par l'organisation en sortent, comme un retrait (acces.ts). Rien n'est effacé chez eux. */
import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { retirerDeLApp, type IssueApp } from '@/lib/tenants/membres';

import { RESERVEES, type DbAcces } from './acces';
import type { Module } from './document';

export type Retrait = { app: Module; hub_user_id: string; etat: IssueApp['etat']; detail?: string };
type Db = DbAcces & Pick<PrismaClient, 'tenant' | 'user' | 'auditLog'>;

/**
 * Pour chaque app réservée NON cochée. Rejoué à chaque réglage : un retrait que l'app a refusé n'est pas perdu, il se refait. Seuls les « organisation »
 * encore dedans ; jamais le propriétaire, jamais un « main ».
 */
export async function retirerVenus(db: Db, tenantId: string, modules: readonly string[], acteur: string, deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}, now = new Date()): Promise<Retrait[]> {
  const fermees = RESERVEES.filter((a) => !modules.includes(a));
  const notes = await db.organisationAcces.findMany({ where: { tenantId, app: { in: [...fermees] }, origine: 'organisation', retireLe: null } });
  if (notes.length === 0) return [];
  const t = await db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { id: true, userId: true, status: true, notifuseWorkspaceSlug: true, metadata: true } });
  if (!t) return [];
  const res: Retrait[] = [];
  for (const n of notes) {
    if (n.hubUserId === t.userId) continue;
    const u = await db.user.findFirst({ where: { supabaseUserId: n.hubUserId }, select: { email: true } });
    // Compte supprimé : le Hub l'a déjà fait couper partout.
    const i: IssueApp = u ? await retirerDeLApp(n.app as Module, t, u.email, n.hubUserId, deps) : { app: n.app as Module, etat: 'absent' };
    const fini = i.etat === 'retire' || i.etat === 'absent';
    if (fini) await db.organisationAcces.updateMany({ where: { tenantId, app: n.app, hubUserId: n.hubUserId, origine: 'organisation', retireLe: null }, data: { retireLe: now } });
    res.push({ app: n.app as Module, hub_user_id: n.hubUserId, etat: i.etat, ...(i.detail ? { detail: i.detail } : {}) });
  }
  if (res.length) await writeAuditLog(db as PrismaClient, { action: 'organisation.decochee', actor: acteur, targetType: 'tenant', targetId: tenantId, payload: { retraits: res } });
  return res;
}
