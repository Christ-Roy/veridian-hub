/**
 * Appartenance à un tenant : le SEUL écrivain de `tenant_members` et de la suspension (VER-245 a, CONTRAT-HUB §5.18 à §5.20).
 * Le Hub dit qui appartient à quoi ; chaque app en garde une copie, que l'on relit après l'avoir changée.
 *
 * Un retrait coupe d'abord au Hub (la porte MCP et tout jeton suivant refusent aussitôt), puis chez chaque app, et RELIT l'app :
 * « retiré » veut dire relu absent. Une app qui ne sait pas retirer, ou qui échoue, est dite ; rejouer le retrait est sans effet de bord.
 */
import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { configuredSyncApps, discoverAppForEmail } from '@/lib/sync/discovery';
import type { SyncApp, TenantSnapshot } from '@/lib/sync/types';

const DELAI_MS = 15_000;
export const ROLES = ['member', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];
export type Origine = 'invitation' | 'reprise' | 'operateur';

export type DbMembres = Pick<PrismaClient, 'tenant' | 'tenantMember' | 'user' | 'auditLog'>;
type Deps = { fetchImpl?: typeof fetch; apps?: readonly SyncApp[]; env?: NodeJS.ProcessEnv };

export class RefusMembre extends Error {
  constructor(readonly code: 'tenant_introuvable' | 'tenant_suspendu' | 'compte_introuvable' | 'adresse_non_prouvee' | 'role_refuse' | 'proprietaire' | 'pas_membre') {
    super(code);
  }
}

/** Routes par app (lues dans leur code le 24/11). Absent : l'app ne sait pas le faire, et c'est dit. */
const RETRAIT: Partial<Record<SyncApp, true>> = { notifuse: true, prospection: true, crm: true };
const SUSPENSION: Partial<Record<SyncApp, true>> = { notifuse: true, prospection: true, academy: true };

async function tenantVivant(db: DbMembres, id: string) {
  const t = await db.tenant.findFirst({ where: { id, deletedAt: null }, select: { id: true, userId: true, status: true, notifuseWorkspaceSlug: true, metadata: true } });
  if (!t) throw new RefusMembre('tenant_introuvable');
  return t;
}
type Tenant = Awaited<ReturnType<typeof tenantVivant>>;

/**
 * Ajoute (ou rétablit) un membre. Une invitation ou une reprise donne `member`, jamais plus : seul un opérateur pose un autre
 * rôle. Un membre déjà là garde le sien. L'adresse est prouvée, ou rien n'est écrit.
 */
export async function rejoindre(db: DbMembres, d: { tenantId: string; hubUserId: string; role?: Role; origine: Origine; acteur: string }): Promise<{ cree: boolean; role: string }> {
  const t = await tenantVivant(db, d.tenantId);
  if (t.status === 'suspended') throw new RefusMembre('tenant_suspendu');
  const u = await db.user.findFirst({ where: { supabaseUserId: d.hubUserId }, select: { emailVerified: true } });
  if (!u) throw new RefusMembre('compte_introuvable');
  if (!u.emailVerified) throw new RefusMembre('adresse_non_prouvee');
  if (t.userId === d.hubUserId) return { cree: false, role: 'owner' };
  const role = d.role ?? 'member';
  if (!ROLES.includes(role) || (role !== 'member' && d.origine !== 'operateur')) throw new RefusMembre('role_refuse');
  const cle = { tenantId_userId: { tenantId: d.tenantId, userId: d.hubUserId } };
  const avant = await db.tenantMember.findUnique({ where: cle });
  if (avant && !avant.deletedAt && (d.origine !== 'operateur' || avant.role === role)) return { cree: false, role: avant.role };
  await db.tenantMember.upsert({
    where: cle,
    create: { tenantId: d.tenantId, userId: d.hubUserId, role, origine: d.origine, ajoutePar: d.acteur },
    update: { role, deletedAt: null, origine: d.origine, ajoutePar: d.acteur },
  });
  await writeAuditLog(db as PrismaClient, { action: 'membre.ajoute', actor: d.acteur, targetType: 'tenant', targetId: d.tenantId, payload: { hub_user_id: d.hubUserId, role, origine: d.origine } });
  return { cree: true, role };
}

export type IssueApp = { app: SyncApp; etat: 'retire' | 'suspendu' | 'repris' | 'absent' | 'non_gere' | 'echec'; detail?: string };

async function signer(app: SyncApp, methode: string, chemin: string, corps: Record<string, unknown>, deps: Deps): Promise<Response> {
  const config = resolveAppConfig(app, deps.env ?? process.env);
  if (!config) throw new Error(`${app}_not_configured`);
  const body = JSON.stringify(corps);
  const ts = String(Date.now());
  return (deps.fetchImpl ?? fetch)(`${config.apiUrl}${chemin}`, {
    method: methode,
    headers: { 'Content-Type': 'application/json', 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': createHmac('sha256', config.hubSecret).update(`${ts}.${body}`).digest('hex') },
    body,
    signal: AbortSignal.timeout(DELAI_MS),
  });
}

function espaceNote(t: Tenant, app: SyncApp): string | null {
  if (app === 'notifuse') return t.notifuseWorkspaceSlug;
  const id = ((t.metadata ?? {}) as Record<string, { workspace_id?: unknown } | undefined>)[app]?.workspace_id;
  return typeof id === 'string' ? id : null;
}

/** Les espaces de ce tenant où l'app voit cette adresse. `null` : l'app ne l'a pas dit. */
async function espacesChez(app: SyncApp, t: Tenant, email: string, hubUserId: string, deps: Deps): Promise<TenantSnapshot[] | null> {
  const r = await discoverAppForEmail(app, email, { timeoutMs: DELAI_MS, fetchImpl: deps.fetchImpl, hubUserId });
  if ('error' in r) return null;
  if (!r.found) return [];
  const note = espaceNote(t, app);
  return r.snapshots.filter((s) => s.status !== 'deleted' && (s.hubTenantLink === t.id || (note !== null && s.workspaceId === note)));
}

/** L'identifiant que l'app attend dans son chemin : son espace, son tenant, ou le tenant Hub. */
const cible = (app: SyncApp, t: Tenant, s: TenantSnapshot): string => (app === 'crm' || app === 'academy' ? t.id : app === 'prospection' ? (s.tenantId ?? s.workspaceId) : s.workspaceId);

async function retirerChez(app: SyncApp, t: Tenant, email: string, hubUserId: string, motif: string, deps: Deps): Promise<IssueApp> {
  try {
    const espaces = await espacesChez(app, t, email, hubUserId, deps);
    if (espaces === null) return { app, etat: 'echec', detail: 'l\'app ne dit pas où est ce compte' };
    if (espaces.length === 0) return { app, etat: 'absent' };
    if (!RETRAIT[app]) return { app, etat: 'non_gere', detail: 'aucune route de retrait dans cette app' };
    for (const s of espaces) {
      const res = await signer(app, 'POST', `/api/tenants/${encodeURIComponent(cible(app, t, s))}/remove-member`, { user_email: email, email, hub_user_id: hubUserId, reason: motif }, deps);
      if (!res.ok && res.status !== 404) return { app, etat: 'echec', detail: `http_${res.status}` };
    }
    const apres = await espacesChez(app, t, email, hubUserId, deps);
    if (apres === null) return { app, etat: 'echec', detail: 'retiré, mais pas relu' };
    return apres.length === 0 ? { app, etat: 'retire' } : { app, etat: 'echec', detail: 'l\'app le voit encore après le retrait' };
  } catch (err) {
    return { app, etat: 'echec', detail: err instanceof Error ? err.message.slice(0, 160) : 'erreur' };
  }
}

/** Retire un membre. Rejouable : déjà retiré au Hub, il est quand même retiré des apps où il resterait. Jamais le propriétaire. */
export async function retirer(db: DbMembres, d: { tenantId: string; hubUserId: string; acteur: string; motif?: 'admin_action' | 'user_request' }, deps: Deps = {}): Promise<{ deja: boolean; apps: IssueApp[]; complet: boolean }> {
  const t = await tenantVivant(db, d.tenantId);
  if (t.userId === d.hubUserId) throw new RefusMembre('proprietaire');
  const cle = { tenantId_userId: { tenantId: d.tenantId, userId: d.hubUserId } };
  const ligne = await db.tenantMember.findUnique({ where: cle });
  const u = await db.user.findFirst({ where: { supabaseUserId: d.hubUserId }, select: { email: true } });
  if (!u) throw new RefusMembre('compte_introuvable');
  const deja = !ligne || ligne.deletedAt !== null;
  if (!deja) await db.tenantMember.update({ where: cle, data: { deletedAt: new Date() } });
  const apps = await Promise.all((deps.apps ?? configuredSyncApps()).map((app) => retirerChez(app, t, u.email, d.hubUserId, d.motif ?? 'admin_action', deps)));
  if (!ligne && apps.every((a) => a.etat === 'absent')) throw new RefusMembre('pas_membre');
  const complet = apps.every((a) => a.etat === 'retire' || a.etat === 'absent');
  await writeAuditLog(db as PrismaClient, { action: 'membre.retire', actor: d.acteur, targetType: 'tenant', targetId: d.tenantId, payload: { hub_user_id: d.hubUserId, deja, complet, apps } });
  return { deja, apps, complet };
}

async function basculerChez(app: SyncApp, t: Tenant, proprietaire: { email: string }, suspendre: boolean, deps: Deps): Promise<IssueApp> {
  try {
    const espaces = await espacesChez(app, t, proprietaire.email, t.userId, deps);
    if (espaces === null) return { app, etat: 'echec', detail: 'l\'app ne dit pas quel espace est relié' };
    if (espaces.length === 0) return { app, etat: 'absent' };
    if (!SUSPENSION[app]) return { app, etat: 'non_gere', detail: 'aucune route de suspension dans cette app' };
    for (const s of espaces) {
      const res = await signer(app, 'POST', `/api/tenants/${suspendre ? 'suspend' : 'resume'}`, { tenant_id: cible(app, t, s), ...(suspendre ? { reason: 'admin_action' } : {}) }, deps);
      if (!res.ok) return { app, etat: 'echec', detail: `http_${res.status}` };
    }
    return { app, etat: suspendre ? 'suspendu' : 'repris' };
  } catch (err) {
    return { app, etat: 'echec', detail: err instanceof Error ? err.message.slice(0, 160) : 'erreur' };
  }
}

/** Suspend ou reprend une organisation : au Hub d'abord (la porte MCP refuse aussitôt), puis chez les apps qui savent le faire. */
export async function basculerSuspension(db: DbMembres, d: { tenantId: string; suspendre: boolean; acteur: string; motif?: string }, deps: Deps = {}): Promise<{ deja: boolean; apps: IssueApp[]; complet: boolean }> {
  const t = await tenantVivant(db, d.tenantId);
  const proprietaire = await db.user.findFirst({ where: { supabaseUserId: t.userId }, select: { email: true } });
  if (!proprietaire) throw new RefusMembre('compte_introuvable');
  const voulu = d.suspendre ? 'suspended' : 'active';
  const deja = t.status === voulu;
  if (!deja) await db.tenant.update({ where: { id: t.id }, data: { status: voulu } });
  const apps = await Promise.all((deps.apps ?? configuredSyncApps()).map((app) => basculerChez(app, t, proprietaire, d.suspendre, deps)));
  const complet = apps.every((a) => a.etat === 'suspendu' || a.etat === 'repris' || a.etat === 'absent');
  await writeAuditLog(db as PrismaClient, { action: d.suspendre ? 'tenant.suspendu' : 'tenant.repris', actor: d.acteur, targetType: 'tenant', targetId: t.id, payload: { deja, complet, apps, motif: d.motif ?? null } });
  return { deja, apps, complet };
}
