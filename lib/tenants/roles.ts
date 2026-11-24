/**
 * Le rôle dans l'organisation, porté par le Hub (VER-245 b.1, CONTRAT-HUB §5.22). Le Hub est la seule source : l'app le traduit dans
 * son rôle natif, au rebond et à chaque changement, et le Hub RELIT. Fermé par défaut, organisation par organisation
 * (`ROLE_PORTE`) : personne n'est promu chez un client sans Robert. Les organisations des comptes de test sont ouvertes.
 */
import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { discoverAppForEmail } from '@/lib/sync/discovery';
import { isTestAccount } from '@/lib/sync/test-residue';
import type { SyncApp } from '@/lib/sync/types';

const DELAI_MS = 15_000;
export type RoleOrg = 'owner' | 'admin' | 'member';
export type Organisation = { hub_tenant_id: string; role: RoleOrg; version: number };
export type IssueRole = { app: SyncApp; etat: 'applique' | 'sans_effet' | 'refuse' | 'ferme' | 'echec'; detail?: string };
type Db = Pick<PrismaClient, 'tenant' | 'tenantMember' | 'user'>;
type Deps = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch };

/** Apps qui traduisent le rôle (leur « servi » fait foi). */
export const APPS_A_ROLE: readonly SyncApp[] = ['crm'];

/** Un rôle illisible vaut `member` : jamais une promotion par erreur. */
export const roleOrg = (r: string | null | undefined): RoleOrg => (r === 'owner' || r === 'proprietaire' ? 'owner' : r === 'admin' ? 'admin' : 'member');

export function rolePorteOuvert(t: { id: string; proprietaire: string | null }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (t.proprietaire && isTestAccount(t.proprietaire)) return true;
  const l = (env.ROLE_PORTE ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return l.includes('tous') || l.includes(t.id);
}

async function ouverts(db: Db, tenants: { id: string; userId: string }[], env: NodeJS.ProcessEnv): Promise<Set<string>> {
  if (tenants.length === 0) return new Set();
  const props = await db.user.findMany({ where: { supabaseUserId: { in: tenants.map((t) => t.userId) } }, select: { supabaseUserId: true, email: true } });
  return new Set(tenants.filter((t) => rolePorteOuvert({ id: t.id, proprietaire: props.find((p) => p.supabaseUserId === t.userId)?.email ?? null }, env)).map((t) => t.id));
}

/** Les organisations vivantes et ouvertes de ce compte, avec son rôle. Jointes au rebond, dans le corps signé. */
export async function organisationsPourRebond(db: Db, hubUserId: string, env: NodeJS.ProcessEnv = process.env): Promise<Organisation[]> {
  const membres = await db.tenantMember.findMany({ where: { userId: hubUserId, deletedAt: null }, select: { tenantId: true, role: true, roleLe: true, joinedAt: true } });
  const tenants = await db.tenant.findMany({ where: { deletedAt: null, status: { notIn: ['suspended', 'deleted'] }, OR: [{ userId: hubUserId }, { id: { in: membres.map((m) => m.tenantId) } }] }, select: { id: true, userId: true, createdAt: true } });
  const ok = await ouverts(db, tenants, env);
  return tenants.filter((t) => ok.has(t.id)).map((t) => {
    if (t.userId === hubUserId) return { hub_tenant_id: t.id, role: 'owner' as const, version: t.createdAt.getTime() };
    const m = membres.find((x) => x.tenantId === t.id)!;
    return { hub_tenant_id: t.id, role: roleOrg(m.role), version: (m.roleLe ?? m.joinedAt).getTime() };
  });
}

async function pousserChez(app: SyncApp, o: Organisation, qui: { email: string; hubUserId: string }, deps: Deps): Promise<IssueRole> {
  try {
    const config = resolveAppConfig(app, deps.env ?? process.env);
    if (!config) return { app, etat: 'echec', detail: `${app}_not_configured` };
    const body = JSON.stringify({ hub_tenant_id: o.hub_tenant_id, hub_user_id: qui.hubUserId, email: qui.email, role: o.role, version: o.version });
    const ts = String(Date.now());
    const res = await (deps.fetchImpl ?? fetch)(`${config.apiUrl}/api/hub/members/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': createHmac('sha256', config.hubSecret).update(`${ts}.${body}`).digest('hex') },
      body,
      signal: AbortSignal.timeout(DELAI_MS),
    });
    const j = (await res.json().catch(() => null)) as { applied?: boolean; reason?: string; error?: string } | null;
    if (res.status === 404 && j?.error === 'tenant_not_linked') return { app, etat: 'sans_effet', detail: 'espace non relié' };
    if (!res.ok || typeof j?.applied !== 'boolean') return { app, etat: 'echec', detail: j?.error ?? `http_${res.status}` };
    if (!j.applied && j.reason === 'not_member') return { app, etat: 'sans_effet', detail: 'pas membre de cet espace' };
    if (!j.applied && j.reason !== 'unchanged' && j.reason !== 'stale') return { app, etat: 'refuse', detail: j.reason ?? 'raison absente' };
    // « Appliqué » veut dire relu : le droit natif, pas ce que l'app dit avoir reçu.
    const r = await discoverAppForEmail(app, qui.email, { timeoutMs: DELAI_MS, fetchImpl: deps.fetchImpl, hubUserId: qui.hubUserId });
    const s = 'found' in r && r.found ? r.snapshots.filter((x) => x.hubRole !== undefined && x.hubTenantLink === o.hub_tenant_id) : [];
    if (s.length !== 1 || typeof s[0].nativeAdmin !== 'boolean') return { app, etat: 'echec', detail: 'appliqué, mais pas relu' };
    return s[0].nativeAdmin === (o.role !== 'member') ? { app, etat: 'applique' } : { app, etat: 'echec', detail: 'l\'app garde un autre droit que celui du Hub' };
  } catch (err) {
    return { app, etat: 'echec', detail: err instanceof Error ? err.message.slice(0, 160) : 'erreur' };
  }
}

/** Pousse le rôle courant d'un compte dans une organisation, chez chaque app qui le traduit. Rien n'est envoyé si c'est fermé. */
export async function pousserRole(db: Db, d: { tenantId: string; hubUserId: string }, deps: Deps = {}): Promise<IssueRole[]> {
  const u = await db.user.findFirst({ where: { supabaseUserId: d.hubUserId }, select: { email: true } });
  const o = (await organisationsPourRebond(db, d.hubUserId, deps.env ?? process.env)).find((x) => x.hub_tenant_id === d.tenantId);
  if (!u || !o) return APPS_A_ROLE.map((app) => ({ app, etat: 'ferme' as const, detail: 'rôle porté fermé pour cette organisation' }));
  return Promise.all(APPS_A_ROLE.map((app) => pousserChez(app, o, { email: u.email, hubUserId: d.hubUserId }, deps)));
}
