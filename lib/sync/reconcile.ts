/**
 * Niveau 3 du tenant sync — Cron de réconciliation périodique.
 *
 * Pattern outbox + reconciliation (cf
 * https://microservices.io/patterns/data/transactional-outbox.html) :
 * pour chaque tenant Hub actif, on appelle `discoverUserApps(email)` puis on
 * compare au snapshot local (`Tenant.notifusePlan`, `prospectionPlan`,
 * `metadata.<app>_status`, etc.). Tout écart est journalisé comme un
 * `TenantDrift` (kind = plan_mismatch | status_mismatch | tenant_missing_app
 * | tenant_extra_app | app_unreachable).
 *
 * MODE PAR DÉFAUT : **dry-run**. Aucune écriture côté Hub. Notifuse, Prospection
 * et Analytics exposent `GET /api/users/by-email`, mais un écart peut toucher le
 * plan d'un client réel : il se lit et se tranche, il ne se répare pas tout seul.
 * On préfère :
 *
 *   1. Logger structuré (Grafana Loki) pour observabilité
 *   2. Alerter Telegram si drifts > N
 *   3. Laisser l'opérateur trancher
 *
 * L'opt-in auto-repair sera activé dans un sprint ultérieur quand tous les
 * endpoints discovery seront livrés et qu'on aura mesuré le taux de drift
 * en conditions réelles.
 *
 * Référence : `todo/2026-05-20-tenant-sync-strategy.md` Niveau 3,
 *             `app/api/cron/cleanup-orphan-users/route.ts` (pattern dry-run),
 *             `lib/trial/run-tick.ts` (pattern runner extrait).
 */

import type { PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from '@/lib/prisma';
import { configuredSyncApps, discoverUserApps } from '@/lib/sync/discovery';
import { auditIdentity, identityCounts } from '@/lib/sync/identity-audit';
import { measureTestResidue, residueCounts, type TestResidue } from '@/lib/sync/test-residue';
import type {
  DiscoveryResult,
  ReconcileSummary,
  SyncApp,
  TenantDrift,
} from '@/lib/sync/types';

/**
 * Snapshot du tenant côté Hub utilisé pour le diff. On lit les colonnes
 * typed (`notifusePlan`, `prospectionPlan`) et la `metadata` JSONB pour
 * les status push'és par le Niveau 2.
 */
interface HubTenantSnapshot {
  hubTenantId: string;
  userEmail: string;
  notifusePlan: string | null;
  prospectionPlan: string | null;
  notifuseWorkspaceSlug: string | null;
  prospectionProvisionedAt: Date | null;
  metadata: Record<string, unknown>;
}

/** Lit le status local pour une app depuis `metadata.<app>_status`. */
function readLocalStatus(meta: Record<string, unknown>, app: SyncApp): string | null {
  const v = meta[`${app}_status`];
  return typeof v === 'string' ? v : null;
}

/** Lit le plan local depuis les colonnes typed Tenant + metadata fallback. */
function readLocalPlan(t: HubTenantSnapshot, app: SyncApp): string | null {
  if (app === 'notifuse') return t.notifusePlan;
  if (app === 'prospection') return t.prospectionPlan;
  // analytics : pas de colonne typed → metadata.<app>_plan
  const v = t.metadata[`${app}_plan`];
  return typeof v === 'string' ? v : null;
}

/**
 * Le Hub a-t-il réellement cette app pour ce tenant ?
 *
 * Jamais d'après les colonnes de plan : `notifusePlan` et `prospectionPlan` ont
 * une valeur par défaut, donc elles ne prouvent aucun provisioning (3 faux
 * `tenant_missing_app` mesurés le 06/11). Analytics vit dans `metadata.analytics`,
 * écrit par `lib/admin/link-app.ts` (2 faux `tenant_extra_app` sinon).
 */
function hubKnowsApp(t: HubTenantSnapshot, app: SyncApp): boolean {
  if (readLocalStatus(t.metadata, app) !== null) return true;
  if (app === 'notifuse') return t.notifuseWorkspaceSlug !== null;
  if (app === 'prospection') return t.prospectionProvisionedAt !== null;
  return readLocalPlan(t, app) !== null || Boolean(t.metadata[app]);
}

/**
 * Noms locaux Prospection ramenés au palier commun. Prospection n'a pas de tier
 * `enterprise` et le stocke en `business` (`mapCanonicalPlanToLocal` côté app) ;
 * les plans offerts suivent `getAppPlansForBundle` (`lib/pricing/helpers.ts`).
 */
const PROSPECTION_PLAN_TIER: Record<string, string> = {
  free: 'freemium',
  enterprise: 'business',
  lifetime_partner: 'business',
  internal: 'business',
  lifetime_site_vitrine: 'pro',
};

function samePlan(app: SyncApp, a: string, b: string): boolean {
  if (app !== 'prospection') return a === b;
  return (PROSPECTION_PLAN_TIER[a] ?? a) === (PROSPECTION_PLAN_TIER[b] ?? b);
}

/**
 * Compare snapshot Hub vs result discovery pour une seule app et émet 0..N
 * drifts. Le caller agrège.
 */
export function diffTenantApp(
  t: HubTenantSnapshot,
  app: SyncApp,
  discovery: DiscoveryResult,
  observedAt: string,
): TenantDrift[] {
  const drifts: TenantDrift[] = [];
  const appResult = discovery.apps[app];

  // App injoignable → on note un drift app_unreachable (sans toucher au Hub).
  if ('error' in appResult) {
    drifts.push({
      hubTenantId: t.hubTenantId,
      app,
      kind: 'app_unreachable',
      hubValue: { plan: readLocalPlan(t, app), status: readLocalStatus(t.metadata, app) },
      appValue: { error: appResult.error },
      observedAt,
    });
    return drifts;
  }

  const hubKnowsThisApp = hubKnowsApp(t, app);

  if (!appResult.found) {
    // App répond "user inconnu". Si le Hub croit avoir cette app
    // provisionnée → drift.
    if (hubKnowsThisApp) {
      drifts.push({
        hubTenantId: t.hubTenantId,
        app,
        kind: 'tenant_missing_app',
        hubValue: { plan: readLocalPlan(t, app), status: readLocalStatus(t.metadata, app) },
        appValue: null,
        observedAt,
      });
    }
    return drifts;
  }

  // App a au moins 1 workspace pour ce user. On compare avec ce que le Hub sait.
  if (!hubKnowsThisApp) {
    // Simple membre d'un workspace appartenant à un autre tenant : situation
    // normale d'une invitation, le Hub n'a rien à en savoir sur CE tenant.
    if (appResult.snapshots.every((s) => s.role === 'member')) return drifts;
    drifts.push({
      hubTenantId: t.hubTenantId,
      app,
      kind: 'tenant_extra_app',
      hubValue: null,
      appValue: { workspaces: appResult.snapshots.length },
      observedAt,
    });
    return drifts;
  }

  // Un user peut être membre de plusieurs workspaces (le sien et celui d'un
  // autre tenant) : l'ordre n'est pas garanti, donc le plan est en écart seulement
  // si AUCUN workspace ne porte le plan du Hub. Le status reste lu sur le 1er.
  const snap = appResult.snapshots[0];
  const localPlan = readLocalPlan(t, app);
  const appPlans = appResult.snapshots.flatMap((s) => (s.plan ? [s.plan] : []));
  if (localPlan && appPlans.length > 0 && !appPlans.some((p) => samePlan(app, p, localPlan))) {
    drifts.push({
      hubTenantId: t.hubTenantId,
      app,
      kind: 'plan_mismatch',
      hubValue: localPlan,
      appValue: appPlans.length === 1 ? appPlans[0] : appPlans,
      observedAt,
    });
  }
  const localStatus = readLocalStatus(t.metadata, app);
  if (snap.status && localStatus && snap.status !== localStatus) {
    drifts.push({
      hubTenantId: t.hubTenantId,
      app,
      kind: 'status_mismatch',
      hubValue: localStatus,
      appValue: snap.status,
      observedAt,
    });
  }

  return drifts;
}

export interface ReconcileOptions {
  /** Limite de tenants à scanner par run. Défaut 100. */
  limit?: number;
  /** Mode auto-repair (P3+). Par défaut dry-run. */
  autoRepair?: boolean;
  /** Apps à interroger. Défaut SYNC_APPS. */
  apps?: readonly SyncApp[];
  /** Prisma override (tests). */
  prisma?: PrismaClient;
  /** Fetch override (tests). */
  fetchImpl?: typeof fetch;
  /** Timeout par app (ms). Défaut 2000. */
  timeoutMs?: number;
  /** Threshold Telegram (nombre de drifts) à partir duquel on alerte. */
  alertThreshold?: number;
}

/**
 * Récupère la fenêtre de tenants à scanner ce tick. Stratégie simple :
 * - Tenants `status='active'` ET `deletedAt IS NULL`
 * - Triés par `updatedAt ASC` (les + anciens d'abord — fairness)
 * - Limit configurable (default 100)
 *
 * Pas de curseur persistant : on suppose un volume < 10k tenants pour la
 * fenêtre P0. Quand on scalera, on ajoutera un curseur `last_reconciled_at`.
 */
async function selectActiveTenants(
  p: PrismaClient,
  limit: number,
): Promise<{ tenants: HubTenantSnapshot[]; withoutUser: string[] }> {
  const rows = await p.tenant.findMany({
    where: {
      status: 'active',
      deletedAt: null,
    },
    select: {
      id: true,
      userId: true,
      notifusePlan: true,
      prospectionPlan: true,
      notifuseWorkspaceSlug: true,
      prospectionProvisionedAt: true,
      metadata: true,
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });

  if (rows.length === 0) return { tenants: [], withoutUser: [] };

  // Lookup batch des emails : Tenant.userId est un UUID (legacy bridge), il
  // map sur User.supabaseUserId. On résout en 1 query au lieu de N.
  const supabaseIds = Array.from(new Set(rows.map((r) => r.userId)));
  const users = await p.user.findMany({
    where: { supabaseUserId: { in: supabaseIds } },
    select: { supabaseUserId: true, email: true },
  });
  const emailBySid = new Map(
    users.map((u) => [u.supabaseUserId as string, u.email]),
  );

  const tenants: HubTenantSnapshot[] = [];
  const withoutUser: string[] = [];
  for (const r of rows) {
    const email = emailBySid.get(r.userId);
    if (!email) {
      withoutUser.push(r.id);
      continue;
    }
    tenants.push({
      hubTenantId: r.id,
      userEmail: email,
      notifusePlan: r.notifusePlan,
      prospectionPlan: r.prospectionPlan,
      notifuseWorkspaceSlug: r.notifuseWorkspaceSlug,
      prospectionProvisionedAt: r.prospectionProvisionedAt,
      metadata: (r.metadata as Record<string, unknown> | null) ?? {},
    });
  }
  return { tenants, withoutUser };
}

/**
 * Point d'entrée du cron. Appelé par `app/api/cron/reconcile-tenants/route.ts`
 * (qui ne fait que l'auth Bearer + dispatch).
 */
export async function runReconcile(
  options: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const limit = options.limit ?? 100;
  const apps = options.apps ?? configuredSyncApps();
  const autoRepair = options.autoRepair === true;
  const p = options.prisma ?? defaultPrisma;
  const errors: ReconcileSummary['errors'] = [];

  // P0 : auto-repair pas encore implémenté côté code. On le bloque en dur
  // pour éviter qu'un opérateur l'active par accident via querystring tant
  // que les endpoints discovery downstream ne sont pas tous livrés.
  if (autoRepair) {
    errors.push({
      message:
        'auto-repair requested but not implemented in P0 — defaulting to dry-run',
    });
  }

  const { tenants, withoutUser } = await selectActiveTenants(p, limit);

  let appsQueried = 0;
  let appsUnreachable = 0;
  const drifts: TenantDrift[] = [];

  for (const t of tenants) {
    try {
      const discovery = await discoverUserApps(t.userEmail, {
        apps,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
      appsQueried += apps.length;

      for (const app of apps) {
        const r = discovery.apps[app];
        if ('error' in r) appsUnreachable += 1;
        const tenantDrifts = diffTenantApp(t, app, discovery, startedAt);
        drifts.push(...tenantDrifts);
      }
    } catch (err) {
      errors.push({
        tenantId: t.hubTenantId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let identity: ReconcileSummary['identity'];
  try {
    identity = await auditIdentity(p, { apps, fetchImpl: options.fetchImpl });
  } catch (err) {
    errors.push({
      message: `identity audit: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  let testResidue: TestResidue | undefined;
  try {
    testResidue = await measureTestResidue(p, identity, withoutUser.length);
  } catch (err) {
    errors.push({ message: `test residue: ${err instanceof Error ? err.message : String(err)}` });
  }

  const summary: ReconcileSummary = {
    usersScanned: tenants.length,
    tenantsWithoutUser: withoutUser,
    identity,
    testResidue,
    appsQueried,
    driftsDetected: drifts.length,
    drifts: drifts.slice(0, 200),
    appsUnreachable,
    startedAt,
    durationMs: Date.now() - startMs,
    mode: 'dry-run', // P0 forcé même si autoRepair=true
    errors,
  };

  // Log structuré pour Grafana Loki — `tag` reconnu par les filtres existants.
  console.log(
    JSON.stringify({
      tag: '[cron-reconcile-tenants]',
      level: 'info',
      mode: summary.mode,
      usersScanned: summary.usersScanned,
      tenantsWithoutUser: withoutUser.length,
      identity: identityCounts(identity),
      testResidue: residueCounts(testResidue),
      appsQueried: summary.appsQueried,
      driftsDetected: summary.driftsDetected,
      appsUnreachable: summary.appsUnreachable,
      duration_ms: summary.durationMs,
      ts: startedAt,
      // Sample de drifts pour debug — payload complet dans la réponse HTTP.
      sample: summary.drifts.slice(0, 10).map((d) => ({
        tenantId: d.hubTenantId,
        app: d.app,
        kind: d.kind,
      })),
    }),
  );

  return summary;
}
