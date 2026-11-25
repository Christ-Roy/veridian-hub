/**
 * Une invitation acceptée rend membre au Hub (VER-245), jamais sur la seule parole de l'app : l'espace doit être relié à un tenant,
 * et l'inviteur doit en être propriétaire ou admin AU HUB. Sinon l'accès à l'app reste celui que l'app a donné, sans appartenance
 * au Hub, et l'audit dit pourquoi. Rôle : member, toujours.
 */
import type { PrismaClient } from '@prisma/client';

import { discoverAppForEmail } from '@/lib/sync/discovery';
import { SYNC_APPS, type SyncApp } from '@/lib/sync/types';
import { RefusMembre, rejoindre } from '@/lib/tenants/membres';
import { noterInvite } from '@/lib/organisations/acces';
import { suivreOrganisation } from '@/lib/organisations/emission';

export type Jonction = { etat: 'joint' | 'deja' | 'espace_non_relie' | 'inviteur_non_habilite' | 'refus' | 'echec'; tenantId?: string; detail?: string };
type Db = Pick<PrismaClient, 'user' | 'tenant' | 'tenantMember' | 'auditLog'>;

/** Le tenant de l'espace visé, et l'inviteur y est-il propriétaire ou admin AU HUB. */
export async function tenantDeLInvitation(
  db: Pick<Db, 'user' | 'tenant' | 'tenantMember'>,
  inv: { inviterUserId: string; targetApp: string; targetWorkspaceId: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ tenantId: string; refus?: undefined } | { refus: 'espace_non_relie' | 'inviteur_non_habilite' | 'echec'; tenantId?: string; detail?: string }> {
  const inviteur = await db.user.findUnique({ where: { id: inv.inviterUserId }, select: { supabaseUserId: true, email: true } });
  if (!inviteur?.supabaseUserId) return { refus: 'inviteur_non_habilite' };
  let tenantId: string | null = null;
  if (inv.targetApp === 'notifuse') {
    tenantId = (await db.tenant.findFirst({ where: { notifuseWorkspaceSlug: inv.targetWorkspaceId, deletedAt: null }, select: { id: true } }))?.id ?? null;
  } else if (SYNC_APPS.includes(inv.targetApp as SyncApp)) {
    const r = await discoverAppForEmail(inv.targetApp as SyncApp, inviteur.email, { timeoutMs: 8_000, hubUserId: inviteur.supabaseUserId, fetchImpl: deps.fetchImpl });
    if ('error' in r) return { refus: 'echec', detail: 'app muette sur l\'espace' };
    tenantId = r.found ? (r.snapshots.find((s) => s.workspaceId === inv.targetWorkspaceId)?.hubTenantLink ?? null) : null;
  }
  if (!tenantId) return { refus: 'espace_non_relie' };
  const t = await db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { userId: true } });
  if (!t) return { refus: 'espace_non_relie' };
  if (t.userId !== inviteur.supabaseUserId) {
    const m = await db.tenantMember.findUnique({ where: { tenantId_userId: { tenantId, userId: inviteur.supabaseUserId } } });
    if (!m || m.deletedAt || (m.role !== 'admin' && m.role !== 'owner')) return { refus: 'inviteur_non_habilite', tenantId };
  }
  return { tenantId };
}

export async function joindreParInvitation(
  db: Db,
  inv: { id: string; inviterUserId: string; targetApp: string; targetWorkspaceId: string; createdAt: Date },
  hubUserId: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<Jonction> {
  try {
    const v = await tenantDeLInvitation(db, inv, deps);
    if (v.refus) return { etat: v.refus, ...(v.tenantId ? { tenantId: v.tenantId } : {}), ...(v.detail ? { detail: v.detail } : {}) };
    const r = await rejoindre(db as never, { tenantId: v.tenantId, hubUserId, origine: 'invitation', acteur: `invitation:${inv.id}`, emiseLe: inv.createdAt });
    // Invité à la main dans une app réservée : décocher ne l'en sortira pas.
    await noterInvite(db as never, v.tenantId, inv.targetApp, hubUserId);
    await suivreOrganisation(db as never, v.tenantId);
    return { etat: r.cree ? 'joint' : 'deja', tenantId: v.tenantId };
  } catch (err) {
    if (err instanceof RefusMembre) return { etat: 'refus', detail: err.code };
    console.error('[invitations] jonction au Hub impossible', err);
    return { etat: 'echec' };
  }
}
