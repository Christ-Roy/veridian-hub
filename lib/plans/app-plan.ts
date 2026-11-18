/**
 * Plan d'Analytics (Rybbit) et du CRM (Twenty), posé au Hub et poussé à l'app.
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

export const PLAN_APPS = ['analytics', 'crm'] as const;
export type PlanApp = (typeof PLAN_APPS)[number];

export const CANONICAL_PLANS = ['free', 'pro', 'business', 'enterprise'] as const;
export type CanonicalPlan = (typeof CANONICAL_PLANS)[number];

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

export type PushResult =
  | { ok: true; previousPlan: string | null }
  | { ok: true; immune: true }
  | { ok: false; error: string; status?: number };

export async function pushAppPlan(
  input: {
    app: PlanApp;
    hubTenantId: string;
    hubUserId: string;
    plan: CanonicalPlan;
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
    plan: CanonicalPlan;
    planSource: PlanSource;
    reason?: string | null;
    setBy?: string | null;
    stripeSubscriptionId?: string | null;
  },
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<PushResult> {
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
