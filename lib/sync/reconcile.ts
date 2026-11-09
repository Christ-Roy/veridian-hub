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
import { buildNotifuseClient } from '@/lib/notifuse/admin-helpers';
import { NotifuseClient } from '@/lib/notifuse/client';
import { auditIdentity, identityCounts } from '@/lib/sync/identity-audit';
import { measureTestResidue, residueCounts, type TestResidue } from '@/lib/sync/test-residue';
import { PLAN_APPS } from '@/lib/plans/app-plan';
import { trialStatusesForTenants } from '@/lib/plans/trial-status';
import { trialMachineEnabled } from '@/lib/webhooks/notifuse-handlers';
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
  /** `supabase_user_id` du propriétaire : jointure transmise aux apps qui la lisent. */
  hubUserId?: string;
  /** Statut d'essai calculé au Hub (`lib/plans/trial-status.ts`), absent s'il n'a pas pu être lu. */
  trialStatus?: string;
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

const APP_CLI: Record<SyncApp, string> = { notifuse: 'notifuse', prospection: 'prospection', analytics: 'analytics', crm: 'crm' };

/** La marche à suivre de chaque écart, en une commande quand c'est possible. Jamais d'adresse client. */
export function remediationFor(d: Pick<TenantDrift, 'hubTenantId' | 'app' | 'kind' | 'hubValue'>): string {
  const plan = typeof d.hubValue === 'object' && d.hubValue && 'plan' in d.hubValue ? (d.hubValue as { plan: unknown }).plan : d.hubValue;
  const repousser = `hub plan ${d.hubTenantId} --app ${APP_CLI[d.app]} --plan ${typeof plan === 'string' ? plan : '<plan>'}`;
  switch (d.kind) {
    case 'plan_mismatch':
      return `l'app n'applique pas le plan du Hub : ${repousser} (le Hub fait foi)`;
    case 'trial_mismatch':
      return `statut d'essai non reçu ou ancien : ${repousser} (repousse plan et statut)`;
    case 'plan_unset':
      return `aucun plan posé au Hub : hub plan ${d.hubTenantId} --app ${APP_CLI[d.app]} --plan <free|pro|business|enterprise>`;
    case 'tenant_missing_app':
      return d.app === 'analytics'
        ? 'compte Rybbit absent ou non relié : premier rebond du client (adresse prouvée), ou relier son hub_user_id ; activation fausse : hub unlink --app analytics'
        : `app activée au Hub sans compte chez elle : recréer par le chemin normal (activation), ou hub unlink --app ${APP_CLI[d.app]}`;
    case 'tenant_extra_app':
      return `compte chez l'app inconnu du Hub : hub link --app ${APP_CLI[d.app]}, ou retirer le compte de l'app`;
    case 'status_mismatch':
      return `statut divergent : relire metadata.${d.app}_status au Hub, puis repousser`;
    case 'app_unreachable':
      return `l'app ne répond pas : nomad-v state, puis relancer hub reconcile`;
    case 'hub_tenant_unlinked':
      return `workspace non relié à ce tenant Hub : hub prospection-relier --tenant ${d.hubTenantId} (rejeu idempotent du provisionnement)`;
  }
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
  // Pendant un essai actif, le plan effectif de Notifuse est pro (le tick le pose, le Hub le garde en free).
  const localPlan =
    app === 'notifuse' && t.trialStatus === 'trial_active' ? 'pro' : readLocalPlan(t, app);
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
  // Analytics et CRM : app activée au Hub, aucun plan posé. Le plan de l'app ne vient de personne.
  if (!localPlan && (PLAN_APPS as readonly string[]).includes(app)) {
    drifts.push({
      hubTenantId: t.hubTenantId,
      app,
      kind: 'plan_unset',
      hubValue: null,
      appValue: appPlans.length === 1 ? appPlans[0] : appPlans,
      observedAt,
    });
  }
  // Statut d'essai : comparé seulement si l'app le rend (`undefined` = non câblé, compté à part).
  const rendus = appResult.snapshots.filter((s) => s.trialStatus !== undefined);
  // « Jamais reçu » (null) face à « aucun essai » (none) n'est pas un écart : l'app n'a rien à savoir.
  const memeEssai = (s: { trialStatus?: string | null }) =>
    s.trialStatus === t.trialStatus || (s.trialStatus === null && t.trialStatus === 'none');
  if (t.trialStatus && rendus.length > 0 && !rendus.some(memeEssai)) {
    drifts.push({
      hubTenantId: t.hubTenantId,
      app,
      kind: 'trial_mismatch',
      hubValue: { plan: localPlan, trial_status: t.trialStatus },
      appValue: rendus.length === 1 ? rendus[0].trialStatus : rendus.map((s) => s.trialStatus),
      observedAt,
    });
  }
  // Lien au tenant Hub (claim tenant_id du MCP) : seulement si l'app le rend, sur ses workspaces propriétaires.
  const proprietaires = appResult.snapshots.filter((s) => s.role !== 'member' && s.hubTenantLink !== undefined);
  if (proprietaires.length > 0 && !proprietaires.some((s) => s.hubTenantLink === t.hubTenantId)) {
    drifts.push({
      hubTenantId: t.hubTenantId,
      app,
      kind: 'hub_tenant_unlinked',
      hubValue: t.hubTenantId,
      appValue: proprietaires.length === 1 ? proprietaires[0].hubTenantLink ?? null : proprietaires.map((s) => s.hubTenantLink ?? null),
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

  // Un statut illisible ne cache aucun tenant : ils sont comparés sans lui.
  const essais = await trialStatusesForTenants(p, rows).catch(() => new Map<string, { status: string }>());
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
      hubUserId: r.userId,
      trialStatus: essais.get(r.id)?.status,
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
  // Par app : a-t-on vu au moins un compte, et l'app rend-elle le statut d'essai ?
  const vu = new Map<SyncApp, { comptes: number; avecEssai: number }>();

  for (const t of tenants) {
    try {
      const discovery = await discoverUserApps(t.userEmail, {
        apps,
        hubUserId: t.hubUserId,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
      appsQueried += apps.length;

      for (const app of apps) {
        const r = discovery.apps[app];
        if ('error' in r) appsUnreachable += 1;
        if ('found' in r && r.found) {
          const v = vu.get(app) ?? { comptes: 0, avecEssai: 0 };
          v.comptes += 1;
          if (r.snapshots.some((s) => s.trialStatus !== undefined)) v.avecEssai += 1;
          vu.set(app, v);
        }
        const tenantDrifts = diffTenantApp(t, app, discovery, startedAt);
        drifts.push(...tenantDrifts.map((d) => ({ ...d, remediation: remediationFor(d) })));
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
    // Un `fetchImpl` injecté veut dire pas de réseau : `NotifuseClient` ne passerait pas par lui.
    const notifuse = options.fetchImpl ? null : buildNotifuseClient();
    testResidue = await measureTestResidue(
      p,
      identity,
      withoutUser.length,
      notifuse instanceof NotifuseClient ? (prefix) => notifuse.listTenantsByPrefix(prefix) : undefined,
    );
  } catch (err) {
    errors.push({ message: `test residue: ${err instanceof Error ? err.message : String(err)}` });
  }

  const notWired = await measureNotWired(p, vu).catch((err: unknown) => [
    `non câblé : mesure impossible (${err instanceof Error ? err.message : String(err)})`,
  ]);

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
    notWired,
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
      notWired: notWired.length,
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

/**
 * Ce qui n'est pas encore branché (Robert, 08/11 : « il faut toujours savoir les écarts »). Chaque ligne
 * est mesurée à ce run, ou porte sa date quand elle ne se mesure pas d'ici. Une ligne disparaît d'elle-même
 * quand la mesure change ; les lignes datées se retirent avec le câblage.
 */
export async function measureNotWired(
  p: Pick<PrismaClient, '$queryRaw'>,
  vu: Map<SyncApp, { comptes: number; avecEssai: number }>,
): Promise<string[]> {
  const out: string[] = [];
  for (const [app, v] of Array.from(vu.entries())) {
    if (v.comptes > 0 && v.avecEssai === 0) {
      out.push(`${app} : statut d'essai non rendu par la découverte (${v.comptes} compte(s) vu(s)) : l'app ne le stocke pas encore`);
    }
  }
  // Un essai RÉEL (hors comptes de test) prouve que Notifuse émet : la batterie (cas 12) ne prouve que
  // la réaction du Hub, et retire sa ligne.
  const [{ reels }] = await p.$queryRaw<Array<{ reels: number }>>`
    SELECT count(*)::int AS reels FROM hub_app.tenant_trials tt
    JOIN hub_app.tenants t ON t.id::text = tt.tenant_id
    JOIN hub_app.users u ON u.supabase_user_id = t.user_id::text
    WHERE u.email NOT LIKE 'e2e-sso-%'`;
  if (!trialMachineEnabled()) {
    out.push(
      "essai : flow d'essai réel coupé (TRIAL_MACHINE_ENABLED absent) : le signal de Notifuse est reçu et journalisé, aucun essai ne démarre pour un client ; l'allumer est une décision de Robert (mécanique prouvée par le cas 12)",
    );
  } else if (reels === 0) {
    out.push(
      "essai : aucun signal d'activité réel reçu de Notifuse (tenant.activity_threshold_reached, émission côté Notifuse) ; la réaction du Hub est prouvée par le cas 12 de la batterie",
    );
  }
  // Hors périmètre, pas un trou : le CMS a son propre pricing (PRICING-VERIDIAN, « Autres apps »).
  out.push('cms : hors périmètre (PRICING) : pricing géré à part (B2B service Robert), ni plan ni statut d\'essai transmis');
  out.push("lecture seule à l'expiration : appliquée par aucune app, drapeau coupé par défaut (décision de Robert)");
  return out;
}
