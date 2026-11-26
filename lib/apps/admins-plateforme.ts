/**
 * L'administrateur de plateforme est ADMIN dans l'espace de chaque client, jamais propriétaire (VER-263, Robert 25/11 : « tout faire comme propriétaire et me
 * faire virer par ce dernier »). Le Hub le désigne par `hub_user_id` (`PLATFORM_ADMINS`) ; l'app garde la désignation. Le client peut le retirer : l'app
 * répond alors `admin_withdrawn` et le Hub NE le remet JAMAIS (seul un geste humain `reinstate`, que ce module n'envoie pas). Contrat : CONTRAT-HUB §5.23.
 * Servi par Mail seul (26/11) ; une app entre dans `APPS_ADMIN` le jour où elle sert `POST /api/hub/workspace-admins`.
 */
import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { adminsPlateforme } from '@/lib/admin/liste-admins';
import { readAppSecret, readAppUrl } from '@/lib/sync/discovery';
import type { SyncApp } from '@/lib/sync/types';

/** Les apps qui servent la route. Les autres se disent « pas encore ». */
export const APPS_ADMIN: readonly SyncApp[] = ['notifuse'];

export type EtatAdmin = 'admin' | 'proprietaire' | 'retire_par_le_client' | 'pas_de_compte' | 'sans_espace' | 'non_branchee' | 'echec';
export type Designation = { app: SyncApp; hubUserId: string; etat: EtatAdmin; detail?: string };
type Db = Pick<PrismaClient, 'tenant' | 'user'>;
type Deps = { fetchImpl?: typeof fetch; acteur: string; raison?: string | null; timeoutMs?: number };
type Membre = { hub_user_id?: string; role?: string; admin_withdrawn?: boolean };

/** Appel signé (HMAC §6.1) ; rend le statut et le corps lu, jamais une exception réseau. */
async function signe(app: SyncApp, methode: 'GET' | 'POST', chemin: string, corps: unknown, d: Deps): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const base = readAppUrl(app);
  const secret = readAppSecret(app);
  if (!base || !secret) return { status: 0, json: null };
  const brut = corps === undefined ? '' : JSON.stringify(corps);
  const ts = Date.now().toString();
  try {
    const r = await (d.fetchImpl ?? fetch)(`${base}${chemin}`, {
      method: methode,
      headers: { 'Content-Type': 'application/json', 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': createHmac('sha256', secret).update(`${ts}.${brut}`).digest('hex') },
      body: brut || undefined,
      signal: AbortSignal.timeout(d.timeoutMs ?? 15_000),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  } catch (err) {
    return { status: -1, json: { error: err instanceof Error ? err.message.slice(0, 120) : 'reseau' } };
  }
}

const code = (j: Record<string, unknown> | null) => (typeof j?.error === 'string' ? j.error : typeof j?.code === 'string' ? j.code : null);

/** Une personne, un espace Mail. Membre d'abord s'il n'y est pas (jamais un « member » poussé sur quelqu'un qui y est déjà : il rétrograderait un propriétaire). */
async function designerDansMail(espace: string, admin: { hubUserId: string; email: string }, d: Deps): Promise<Designation> {
  const de = (etat: EtatAdmin, detail?: string): Designation => ({ app: 'notifuse', hubUserId: admin.hubUserId, etat, ...(detail ? { detail } : {}) });
  const lu = await signe('notifuse', 'GET', `/api/hub/workspace-admins?workspace_id=${encodeURIComponent(espace)}`, undefined, d);
  if (lu.status === 0) return de('non_branchee', 'Mail non branché ici');
  if (lu.status === 404) return de('sans_espace', code(lu.json) ?? 'espace introuvable chez Mail');
  if (lu.status !== 200 || !Array.isArray(lu.json?.members)) return de('echec', `relecture impossible (${lu.status}${code(lu.json) ? ` ${code(lu.json)}` : ''})`);
  const moi = (lu.json!.members as Membre[]).find((m) => m.hub_user_id === admin.hubUserId);
  if (moi?.admin_withdrawn) return de('retire_par_le_client');
  if (moi?.role === 'owner') return de('proprietaire');
  if (!moi) {
    const ajout = await signe('notifuse', 'POST', `/api/tenants/${encodeURIComponent(espace)}/sync-member`, { email: admin.email, hub_user_id: admin.hubUserId, email_proven: true, role: 'member' }, d);
    if (ajout.status === 409 && code(ajout.json) === 'admin_withdrawn') return de('retire_par_le_client');
    if (ajout.status === 404 && code(ajout.json) === 'user_not_in_app') return de('pas_de_compte', 'aucun compte Mail relié à cette personne');
    if (ajout.status !== 200) return de('echec', `ajout comme membre refusé (${ajout.status}${code(ajout.json) ? ` ${code(ajout.json)}` : ''})`);
  }
  const r = await signe('notifuse', 'POST', '/api/hub/workspace-admins', {
    workspace_id: espace, hub_user_id: admin.hubUserId, action: 'grant', actor_hub_user_id: d.acteur, reason: d.raison?.trim() || 'administrateur de plateforme (Hub)', reinstate: false,
  }, d);
  if (r.status === 409 && code(r.json) === 'admin_withdrawn') return de('retire_par_le_client');
  if (r.status === 404 && code(r.json) === 'user_not_in_app') return de('pas_de_compte', 'aucun compte Mail relié à cette personne');
  if (r.status !== 200) return de('echec', `désignation refusée (${r.status}${code(r.json) ? ` ${code(r.json)}` : ''})`);
  // Relu : « admin » ne se dit que si l'app le rend.
  const apres = await signe('notifuse', 'GET', `/api/hub/workspace-admins?workspace_id=${encodeURIComponent(espace)}`, undefined, d);
  const role = (apres.json?.members as Membre[] | undefined)?.find((m) => m.hub_user_id === admin.hubUserId)?.role;
  return role === 'admin' ? de('admin') : role === 'owner' ? de('proprietaire') : de('echec', `relu : ${role ?? 'absent'}`);
}

/**
 * Pose chaque administrateur de plateforme dans les espaces de cette organisation. Rejouable : déjà admin, rien ne change ; retiré par le client, rien n'est
 * remis. `null` : organisation introuvable.
 */
export async function designerAdminsPlateforme(db: Db, tenantId: string, d: Deps): Promise<Designation[] | null> {
  const t = await db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { userId: true, notifuseWorkspaceSlug: true } });
  if (!t) return null;
  const ids = Array.from(adminsPlateforme()).filter((id) => id !== t.userId);
  const admins = await db.user.findMany({ where: { supabaseUserId: { in: ids }, emailVerified: { not: null } }, select: { supabaseUserId: true, email: true } });
  const res: Designation[] = [];
  for (const id of ids) {
    const a = admins.find((x) => x.supabaseUserId === id);
    if (!a) { res.push({ app: 'notifuse', hubUserId: id, etat: 'pas_de_compte', detail: 'aucun compte prouvé au Hub' }); continue; }
    res.push(t.notifuseWorkspaceSlug ? await designerDansMail(t.notifuseWorkspaceSlug, { hubUserId: id, email: a.email }, d) : { app: 'notifuse', hubUserId: id, etat: 'sans_espace' });
  }
  return res;
}

/** Ce qui n'est pas « fait » : un échec. Retiré par le client, propriétaire, sans espace : des états voulus, pas des pannes. */
export const designationEnEchec = (l: readonly Designation[]): boolean => l.some((x) => x.etat === 'echec');
