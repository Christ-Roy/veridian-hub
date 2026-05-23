/**
 * Résout l'état billing courant d'un tenant pour une app downstream.
 *
 * Spec : `docs/CONTRAT-BILLING.md` §6.3 — endpoint POLL de réconciliation.
 *
 * Shape de réponse (gravé §6.3, ne pas étendre sans bump de contract_version) :
 *
 *   {
 *     tenant_id, plan, plan_source,
 *     stripe_subscription_id, effective_at, updated_at
 *   }
 *
 * Mapping plan_source v1 (interne Hub, stocké dans `tenant.metadata.<app>_plan_source`)
 * → v2 (canonique CONTRAT-BILLING §3.3) :
 *
 *   v1 'stripe'              → v2 'stripe'           (subscription Stripe payante)
 *   v1 'manual'              → v2 'grant_manual'     (offert par admin)
 *   v1 'lifetime_site_vitrine'/'lifetime_partner'/'internal'
 *                            → v2 'grant_manual'     (immune Stripe)
 *
 * Cas v2 dérivés :
 *   - 'stripe_trial'   → si TenantTrial state ∈ {trial_active, trial_ending_soon}
 *                        pour ce (tenant, app). Le trial prime sur 'stripe'
 *                        v1 si pas encore de sub Stripe payante (sub_id null).
 *   - 'downgrade_auto' → si TenantTrial state='expired' et plan=free, OU si
 *                        plan=free + plan_source v1 'stripe' (sub annulée).
 *
 * Cache : LRU léger 10s TTL, clé `(tenantId, app)`. Évite le spam DB sur un
 * cron app qui poll en boucle. In-memory (Hub mono-instance Dokploy — si on
 * passe multi-instance, basculer sur Redis).
 */

import { prisma } from '@/lib/prisma';
import type { SupportedApp } from './billing-state-hmac';

export type BillingStatePlan = 'free' | 'pro' | 'business' | 'enterprise';
export type BillingStatePlanSource =
  | 'stripe'
  | 'stripe_trial'
  | 'grant_manual'
  | 'downgrade_auto';

export interface BillingStateResponse {
  tenant_id: string;
  plan: BillingStatePlan;
  plan_source: BillingStatePlanSource;
  stripe_subscription_id: string | null;
  effective_at: string;
  updated_at: string;
}

export type BillingStateError =
  | { code: 'tenant_not_found' }
  | { code: 'unknown_plan'; details: string };

export type BillingStateResult =
  | { ok: true; response: BillingStateResponse; cached: boolean }
  | { ok: false; error: BillingStateError };

const CACHE_TTL_MS = 10_000;

/**
 * Entrée de cache. On stocke le résultat complet pour ne pas re-calculer
 * le mapping plan_source à chaque hit.
 */
interface CacheEntry {
  response: BillingStateResponse;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Utilitaire tests : vide le cache. Pas exporté en runtime nominal. */
export function clearBillingStateCache(): void {
  cache.clear();
}

/** Utilitaire tests : taille actuelle du cache. */
export function billingStateCacheSize(): number {
  return cache.size;
}

function cacheKey(tenantId: string, app: SupportedApp): string {
  return `${app}::${tenantId}`;
}

/**
 * Normalise une chaîne en BillingStatePlan canonique. Gère les noms locaux
 * Prospection (`freemium` → `free`) qui peuvent apparaître dans
 * `tenant.prospectionPlan`.
 */
function normalizePlan(raw: string | null | undefined): BillingStatePlan | null {
  if (!raw) return null;
  const v = raw.toLowerCase().trim();
  switch (v) {
    case 'free':
    case 'freemium':
      return 'free';
    case 'pro':
      return 'pro';
    case 'business':
      return 'business';
    case 'enterprise':
      return 'enterprise';
    default:
      return null;
  }
}

/**
 * Extrait la valeur de plan_source v1 stockée dans `tenant.metadata.<app>_plan_source`.
 * Renvoie 'manual' par défaut (cohérent `utils/stripe/prisma-sync.ts:261`).
 */
function readV1PlanSource(
  metadata: Record<string, unknown> | null,
  app: SupportedApp,
): string {
  if (!metadata) return 'manual';
  const key = `${app}_plan_source`;
  const v = metadata[key];
  return typeof v === 'string' && v.length > 0 ? v : 'manual';
}

/**
 * Date d'effet — quand le plan courant a été appliqué.
 * Stocké dans `tenant.metadata.<app>_plan_set_at` par les routes admin
 * (cf `app/api/admin/notifuse/update-plan/route.ts:122`). Fallback :
 * `tenant.updatedAt` (dernière modif du tenant, pas forcément du plan
 * mais c'est notre meilleure estimation si l'admin route n'a pas posé le
 * champ — cas tenants pre-migration v2).
 */
function readEffectiveAt(
  metadata: Record<string, unknown> | null,
  app: SupportedApp,
  fallback: Date,
): Date {
  if (metadata) {
    const key = `${app}_plan_set_at`;
    const raw = metadata[key];
    if (typeof raw === 'string') {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return fallback;
}

/**
 * Mappe (planSourceV1, plan, stripeSubscriptionId, trialState) → plan_source v2.
 *
 * Règle (cf doc en tête du module) :
 *   - `lifetime_xxx` / internal / manual → grant_manual
 *   - trial_active ou trial_ending_soon sans sub Stripe payante → stripe_trial
 *   - plan=free + (trial expired OU ex-stripe annulée) → downgrade_auto
 *   - sinon → stripe
 */
function mapPlanSource(input: {
  planSourceV1: string;
  plan: BillingStatePlan;
  stripeSubscriptionId: string | null;
  trialState: string | null;
}): BillingStatePlanSource {
  const { planSourceV1, plan, stripeSubscriptionId, trialState } = input;

  // 1. grant_manual : tous les "plans offerts" v1 collapsent ici.
  if (
    planSourceV1 === 'manual' ||
    planSourceV1 === 'lifetime_site_vitrine' ||
    planSourceV1 === 'lifetime_partner' ||
    planSourceV1 === 'internal'
  ) {
    return 'grant_manual';
  }

  // 2. stripe_trial : trial state machine active + pas encore de sub payante.
  //    Si une sub Stripe est arrivée pendant le trial (conversion), on bascule
  //    sur 'stripe' direct — c'est le sens du `if (stripeSubscriptionId)`
  //    qui prend précédence ci-dessous.
  if (
    !stripeSubscriptionId &&
    (trialState === 'trial_active' || trialState === 'trial_ending_soon')
  ) {
    return 'stripe_trial';
  }

  // 3. downgrade_auto : plan=free + soit trial expired, soit sub Stripe annulée
  //    (sub_id null + plan_source v1 'stripe' = ancienne sub résiliée).
  if (plan === 'free') {
    if (trialState === 'expired') return 'downgrade_auto';
    // Le cas "ex-stripe annulée" : v1 plan_source='stripe' mais plus de sub
    // → l'utilisateur a annulé son abo Stripe.
    if (planSourceV1 === 'stripe' && !stripeSubscriptionId) {
      return 'downgrade_auto';
    }
  }

  // 4. Défaut : stripe (subscription Stripe payante active).
  return 'stripe';
}

/**
 * Récupère l'état billing d'un tenant pour une app, avec cache 10s TTL.
 *
 * Le caller (route) doit avoir vérifié HMAC + isolation app au préalable.
 * Cette fonction ne fait que la lecture DB + mapping v1→v2.
 */
export async function getBillingState(
  tenantId: string,
  app: SupportedApp,
  options: {
    /** Override d'horloge pour les tests. */
    nowMs?: number;
    /** Bypass cache (utile en tests d'intégration). */
    skipCache?: boolean;
  } = {},
): Promise<BillingStateResult> {
  const now = options.nowMs ?? Date.now();
  const key = cacheKey(tenantId, app);

  if (!options.skipCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      return { ok: true, response: hit.response, cached: true };
    }
    if (hit) cache.delete(key);
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      notifusePlan: true,
      prospectionPlan: true,
      metadata: true,
      updatedAt: true,
      subscription: {
        select: {
          stripeSubscriptionId: true,
        },
      },
    },
  });

  if (!tenant || !tenant.id) {
    return { ok: false, error: { code: 'tenant_not_found' } };
  }

  const rawPlan = app === 'notifuse' ? tenant.notifusePlan : tenant.prospectionPlan;
  const plan = normalizePlan(rawPlan);
  if (!plan) {
    // Plan stocké inconnu (ex : valeur corrompue) — on remonte une erreur
    // explicite plutôt que d'inventer un défaut qui désynchronisera l'app.
    return {
      ok: false,
      error: {
        code: 'unknown_plan',
        details: `tenant ${tenantId} app=${app} has unknown local plan="${rawPlan ?? 'null'}"`,
      },
    };
  }

  const metadata = (tenant.metadata as Record<string, unknown> | null) ?? null;
  const planSourceV1 = readV1PlanSource(metadata, app);

  // TrialState : on lit la row TenantTrial pour ce (tenantId, app) si elle existe.
  // Pas de trial = pas de row, traité comme `null` (aucun effet sur mapping).
  const trial = await prisma.tenantTrial.findUnique({
    where: { tenantId_app: { tenantId, app } },
    select: { state: true },
  });
  const trialState = trial?.state ?? null;

  const stripeSubscriptionId = tenant.subscription?.stripeSubscriptionId ?? null;

  const planSource = mapPlanSource({
    planSourceV1,
    plan,
    stripeSubscriptionId,
    trialState,
  });

  const effectiveAt = readEffectiveAt(metadata, app, tenant.updatedAt);

  const response: BillingStateResponse = {
    tenant_id: tenant.id,
    plan,
    plan_source: planSource,
    stripe_subscription_id: stripeSubscriptionId,
    effective_at: effectiveAt.toISOString(),
    updated_at: tenant.updatedAt.toISOString(),
  };

  if (!options.skipCache) {
    cache.set(key, { response, expiresAt: now + CACHE_TTL_MS });
  }

  return { ok: true, response, cached: false };
}

/** Exposé pour les tests unitaires du mapping seul. */
export const __test = {
  mapPlanSource,
  normalizePlan,
  readV1PlanSource,
  readEffectiveAt,
  CACHE_TTL_MS,
};
