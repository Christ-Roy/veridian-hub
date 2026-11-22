/**
 * Plan d'Analytics (Rybbit), du CRM (Twenty) et d'Academy, posé au Hub et poussé à l'app.
 *
 * Même chemin que Notifuse et Prospection : `POST <app>/api/tenants/update-plan`, CONTRAT-BILLING §3
 * v2, signé §6.1, plus `hub_user_id` (Rybbit ne connaît pas les tenants du Hub, il connaît ses
 * comptes) et le statut d'essai (`trial_status`, `trial_ends_at`, `lib/plans/trial-status.ts`).
 * L'app stocke, rien n'est limité (PRICING-VERIDIAN : générosité maximale).
 *
 * Le Hub retient le plan dans `metadata.<app>_plan` (et `_plan_source`), que `hub reconcile` compare
 * au plan rendu par la découverte de l'app. Un refus de l'app n'écrit rien : pas d'écart silencieux.
 */
import { createHmac, randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { trialStatusForTenant, type TenantTrialStatus } from '@/lib/plans/trial-status';

/** Apps à plan canonique qui suivent le bundle Stripe et la machine d'essai. */
export const PLAN_APPS = ['analytics', 'crm'] as const;

/**
 * Toutes les apps dont le Hub pose le plan (`hub plan --app <app>`). Academy a sa propre grille et
 * ne suit ni Stripe ni l'essai : ses plans se posent à la main (demande de Robert du 22/11).
 */
export const PLANNED_APPS = ['analytics', 'crm', 'academy'] as const;
export type PlanApp = (typeof PLANNED_APPS)[number];

export const CANONICAL_PLANS = ['free', 'pro', 'business', 'enterprise'] as const;
export type CanonicalPlan = (typeof CANONICAL_PLANS)[number];

/** Grille d'Academy, telle que l'app la valide. Les trois derniers sont offerts (`grant_manual`). */
export const ACADEMY_PLANS = ['free', 'entreprise', 'internal', 'lifetime_partner', 'lifetime_site_vitrine'] as const;

export const APP_PLAN_GRIDS: Record<PlanApp, readonly string[]> = {
  analytics: CANONICAL_PLANS,
  crm: CANONICAL_PLANS,
  academy: ACADEMY_PLANS,
};

/** Le plan fait-il partie de la grille de cette app ? */
export const isAppPlan = (app: PlanApp, v: unknown): v is string =>
  typeof v === 'string' && APP_PLAN_GRIDS[app].includes(v);

export const isPlannedApp = (v: unknown): v is PlanApp =>
  typeof v === 'string' && (PLANNED_APPS as readonly string[]).includes(v);

export type PlanSource = 'stripe' | 'stripe_trial' | 'grant_manual' | 'downgrade_auto';

export const isCanonicalPlan = (v: unknown): v is CanonicalPlan =>
  typeof v === 'string' && (CANONICAL_PLANS as readonly string[]).includes(v);

const UPDATE_PLAN_PATH = '/api/tenants/update-plan';
const TIMEOUT_MS = 10_000;

/** Palier des apps sans grille propre, d'après le bundle Stripe. Hors bundle : on n'y touche pas. */
const BUNDLE_TIER: Record<string, CanonicalPlan> = {
  'veridian-pro': 'pro',
  'veridian-business': 'business',
  'lifetime-site-vitrine': 'pro',
  'lifetime-partner': 'business',
  internal: 'enterprise',
};

export function bundleTier(planKey: string | null | undefined, isActive: boolean): CanonicalPlan | null {
  if (!planKey || !(planKey in BUNDLE_TIER)) return null;
  return isActive ? BUNDLE_TIER[planKey] : 'free';
}

type Meta = Record<string, unknown>;
const asMeta = (m: unknown): Meta => (m && typeof m === 'object' && !Array.isArray(m) ? (m as Meta) : {});

/** Le Hub a-t-il cette app pour ce tenant ? Même règle que `hubKnowsApp` de reconcile. */
export function tenantHasApp(metadata: unknown, app: PlanApp): boolean {
  const meta = asMeta(metadata);
  return Boolean(meta[app]) || typeof meta[`${app}_plan`] === 'string';
}

export function readAppPlan(metadata: unknown, app: PlanApp): { plan: string | null; source: string | null } {
  const meta = asMeta(metadata);
  const plan = meta[`${app}_plan`];
  const source = meta[`${app}_plan_source`];
  return { plan: typeof plan === 'string' ? plan : null, source: typeof source === 'string' ? source : null };
}

const PLAN_SOURCES: readonly PlanSource[] = ['stripe', 'stripe_trial', 'grant_manual', 'downgrade_auto'];

/**
 * Plan à repousser à une app au moment où son espace naît ou s'active : celui que le Hub a déjà
 * choisi, avec sa propre source, ou rien. Jamais un `free` par défaut marqué `grant_manual` : un
 * plan offert est immunisé contre Stripe (CONTRAT-BILLING §3.4), et ce free-là ne l'était pas.
 */
export function choisirPlanInitial(
  metadata: unknown,
  app: PlanApp,
): { plan: string; planSource: PlanSource } | null {
  const { plan, source } = readAppPlan(metadata, app);
  if (!isAppPlan(app, plan)) return null;
  const planSource = (PLAN_SOURCES as readonly string[]).includes(source ?? '') ? (source as PlanSource) : null;
  if (!planSource) return null;
  if (planSource === 'grant_manual' && plan === 'free') return null;
  return { plan, planSource };
}

export type PushResult =
  | { ok: true; previousPlan: string | null }
  | { ok: true; immune: true }
  | { ok: false; error: string; status?: number };

export async function pushAppPlan(
  input: {
    app: PlanApp;
    hubTenantId: string;
    hubUserId: string;
    plan: string;
    planSource: PlanSource;
    reason?: string | null;
    stripeSubscriptionId?: string | null;
    trial?: TenantTrialStatus;
  },
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; nowMs?: () => number } = {},
): Promise<PushResult> {
  const config = resolveAppConfig(input.app, opts.env ?? process.env);
  if (!config) return { ok: false, error: `${input.app}_not_configured` };
  const body = JSON.stringify({
    contract_version: '2.0',
    tenant_id: input.hubTenantId,
    hub_user_id: input.hubUserId,
    plan: input.plan,
    plan_source: input.planSource,
    effective_at: new Date().toISOString(),
    stripe_subscription_id: input.stripeSubscriptionId ?? null,
    idempotency_key: randomUUID(),
    reason: (input.reason ?? 'hub').slice(0, 500),
    trial_status: input.trial?.status ?? 'none',
    trial_ends_at: input.trial?.endsAt ?? null,
  });
  const timestamp = String((opts.nowMs ?? Date.now)());
  const signature = createHmac('sha256', config.hubSecret).update(`${timestamp}.${body}`).digest('hex');
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(`${config.apiUrl}${UPDATE_PLAN_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Veridian-Timestamp': timestamp,
        'X-Veridian-Hub-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `${input.app}_unreachable: ${err instanceof Error ? err.message : 'network'}` };
  }
  const data = (await response.json().catch(() => null)) as { error?: string; previous_plan?: string | null } | null;
  if (response.status === 409 && data?.error === 'plan_source_immutable') return { ok: true, immune: true };
  if (!response.ok) {
    return { ok: false, error: data?.error ?? `${input.app}_http_${response.status}`, status: response.status };
  }
  return { ok: true, previousPlan: data?.previous_plan ?? null };
}

type PlanDb = Pick<PrismaClient, 'tenant' | 'tenantTrial' | 'subscription'>;

/**
 * Pose le plan d'une app pour un tenant : poussée à l'app, puis écriture au Hub si elle l'accepte.
 * `immune` (plan offert côté app) n'écrit rien : le Hub ne doit pas afficher un plan que l'app refuse.
 */
export async function setAppPlan(
  db: PlanDb,
  input: {
    tenantId: string;
    app: PlanApp;
    plan: string;
    planSource: PlanSource;
    reason?: string | null;
    setBy?: string | null;
    stripeSubscriptionId?: string | null;
  },
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<PushResult> {
  // Garde au plus près de l'écriture : un plan hors grille ne part jamais vers l'app.
  if (!isAppPlan(input.app, input.plan)) return { ok: false, error: `plan_invalid_for_${input.app}`, status: 400 };
  const tenant = await db.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true, userId: true } });
  if (!tenant) return { ok: false, error: 'tenant_not_found', status: 404 };
  const trial = await trialStatusForTenant(db, tenant.id);
  const pushed = await pushAppPlan({ ...input, hubTenantId: tenant.id, hubUserId: tenant.userId, trial }, opts);
  if (!pushed.ok || 'immune' in pushed) return pushed;
  // Relu juste avant l'écriture : une autre écriture de metadata (activation, Stripe) ne se perd pas.
  const fresh = await db.tenant.findUnique({ where: { id: tenant.id }, select: { metadata: true } });
  await db.tenant.update({
    where: { id: tenant.id },
    data: {
      metadata: {
        ...asMeta(fresh?.metadata),
        [`${input.app}_plan`]: input.plan,
        [`${input.app}_plan_source`]: input.planSource,
        [`${input.app}_plan_set_at`]: new Date().toISOString(),
        [`${input.app}_plan_set_by`]: input.setBy ?? 'hub',
      } as object,
    },
  });
  return pushed;
}
