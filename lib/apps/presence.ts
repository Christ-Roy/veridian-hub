/**
 * Cette personne est-elle VRAIMENT dans l'espace de cette organisation, app par app ? Relu chez l'app, jamais déduit de ce qu'on lui a envoyé (Robert, 25/11 :
 * « ça n'ouvre pas correctement les comptes » : le Hub disait « créé », Mail n'avait personne). Une app qui ne répond pas : on ne sait pas, et on le dit.
 */
import type { PrismaClient } from '@prisma/client';

import { NotifuseClient } from '@/lib/notifuse/client';
import { configuredSyncApps, discoverAppForEmail } from '@/lib/sync/discovery';
import type { SyncApp } from '@/lib/sync/types';

/** `sans_espace` : l'organisation n'a pas d'espace dans cette app ; `non_cochee` : il existe, mais l'organisation n'y emmène pas ses membres. */
export type Presence = { app: SyncApp; etat: 'presente' | 'absente' | 'non_cochee' | 'sans_espace' | 'illisible'; detail?: string };
type Db = Pick<PrismaClient, 'tenant' | 'user' | 'organisation'>;
type Deps = { fetchImpl?: typeof fetch; apps?: readonly SyncApp[] };
type TenantLu = { id: string; userId: string; notifuseWorkspaceSlug: string | null; prospectionProvisionedAt: Date | null; metadata: unknown };

export function espaceNote(t: Pick<TenantLu, 'notifuseWorkspaceSlug' | 'prospectionProvisionedAt' | 'metadata'>, app: SyncApp): string | true | null {
  if (app === 'notifuse') return t.notifuseWorkspaceSlug;
  if (app === 'prospection') return t.prospectionProvisionedAt ? true : null;
  const id = ((t.metadata ?? {}) as Record<string, { workspace_id?: unknown } | undefined>)[app]?.workspace_id;
  return typeof id === 'string' && id ? id : null;
}

/** Mail liste encore un espace supprimé, sans son état (mesuré le 25/11 par l'épreuve) : l'état se lit sur l'espace lui-même. Illisible : on ne sait pas. */
export async function espaceMailVivant(slug: string, deps: Pick<Deps, 'fetchImpl'> = {}): Promise<boolean | null> {
  const apiUrl = process.env.NOTIFUSE_API_URL;
  const hubSecret = process.env.NOTIFUSE_HUB_API_SECRET;
  if (!apiUrl || !hubSecret) return null;
  try {
    const r = await new NotifuseClient({ apiUrl, hubSecret, maxRetries: 0, timeoutMs: 8_000, fetchImpl: deps.fetchImpl }).getStatus(slug);
    return typeof r.status === 'string' ? r.status === 'active' && !r.deleted_at : null;
  } catch {
    return null;
  }
}

/** Dans UNE app. L'espace se reconnaît à son lien au Hub, sinon à l'identifiant que le Hub a noté. */
export async function presenteDans(app: SyncApp, t: TenantLu, u: { email: string; hubUserId: string }, deps: Deps = {}): Promise<boolean | null> {
  const r = await discoverAppForEmail(app, u.email, { hubUserId: u.hubUserId, fetchImpl: deps.fetchImpl, timeoutMs: 8_000 });
  if ('error' in r) return null;
  if (!r.found) return false;
  const note = espaceNote(t, app);
  const ici = r.snapshots.filter((s) => s.status !== 'deleted' && (s.hubTenantLink === t.id || (typeof note === 'string' && s.workspaceId === note)));
  if (app !== 'notifuse' || ici.length === 0) return ici.length > 0;
  const etats = await Promise.all(ici.map((s) => espaceMailVivant(s.workspaceId, deps)));
  return etats.includes(true) ? true : etats.includes(null) ? null : false;
}

export async function presenceDe(db: Db, tenantId: string, hubUserId: string, deps: Deps = {}): Promise<Presence[]> {
  const [t, u, o] = await Promise.all([
    db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { id: true, userId: true, notifuseWorkspaceSlug: true, prospectionProvisionedAt: true, metadata: true } }),
    db.user.findFirst({ where: { supabaseUserId: hubUserId }, select: { email: true } }),
    db.organisation.findUnique({ where: { tenantId }, select: { modules: true } }),
  ]);
  if (!t || !u) return [];
  return Promise.all((deps.apps ?? configuredSyncApps()).map(async (app): Promise<Presence> => {
    if (!espaceNote(t, app)) return { app, etat: 'sans_espace' };
    const p = await presenteDans(app, t, { email: u.email, hubUserId }, deps);
    if (p === null) return { app, etat: 'illisible' };
    if (p) return { app, etat: 'presente' };
    const proprietaire = t.userId === hubUserId;
    return proprietaire || o?.modules.includes(app) ? { app, etat: 'absente' } : { app, etat: 'non_cochee', detail: 'l\'organisation n\'emmène pas ses membres dans cette app' };
  }));
}

/** Attendue et pas là, ou illisible : ce n'est pas « fait ». */
export const presenceIncomplete = (l: readonly Presence[]): boolean => l.some((p) => p.etat === 'absente' || p.etat === 'illisible');
