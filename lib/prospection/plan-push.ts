/**
 * Propage un plan du Hub vers Prospection (`POST /api/tenants/update-plan`, contrat
 * billing v2). Sans ça, le Hub affiche un plan que l'app n'applique pas : 5 écarts
 * mesurés le 06/11/2026, dont des clients `enterprise` au Hub et `freemium` dans l'app.
 *
 * L'id de tenant Prospection ne coïncide avec celui du Hub que sur 10 tenants sur 40 :
 * on le lit dans `GET /api/users/by-email`. S'il reste un doute sur le tenant visé, on
 * refuse. On ne devine jamais le plan d'un client.
 */

import { randomUUID } from 'node:crypto';

import { createProspectionClientFromEnv, ProspectionError } from '@/lib/prospection/client';
import { discoverAppForEmail } from '@/lib/sync/discovery';

const OWNER_ROLES = new Set(['owner', 'admin']);
const CANONICAL_PLAN: Record<string, string> = {
  free: 'free',
  freemium: 'free',
  pro: 'pro',
  business: 'business',
  enterprise: 'enterprise',
};

export type PlanSource = 'stripe' | 'stripe_trial' | 'grant_manual' | 'downgrade_auto';

export type PlanPushResult =
  | { ok: true; prospectionTenantId: string }
  | { ok: true; immune: true }
  | { ok: false; error: string };

export async function pushProspectionPlan(input: {
  hubTenantId: string;
  email: string;
  plan: string;
  planSource: PlanSource;
  reason?: string | null;
  trial?: { status: string; endsAt: string | null };
}): Promise<PlanPushResult> {
  const plan = CANONICAL_PLAN[input.plan];
  if (!plan) return { ok: false, error: `plan_not_canonical: ${input.plan}` };

  const client = createProspectionClientFromEnv();
  if (!client) return { ok: false, error: 'prospection_not_configured' };

  const found = await discoverAppForEmail('prospection', input.email);
  if ('error' in found) return { ok: false, error: `discovery: ${found.error}` };
  if (!found.found) return { ok: false, error: 'user_not_in_app' };

  const owned = found.snapshots.filter((s) => s.tenantId && OWNER_ROLES.has(s.role ?? ''));
  const ids = Array.from(new Set(owned.map((s) => s.tenantId as string)));
  const target = ids.includes(input.hubTenantId) ? input.hubTenantId : ids.length === 1 ? ids[0] : null;
  if (!target) {
    return {
      ok: false,
      error: ids.length === 0 ? 'prospection_tenant_id_unknown' : 'prospection_tenant_ambiguous',
    };
  }

  try {
    await client.updatePlan({
      tenantId: target,
      plan,
      planSource: input.planSource,
      idempotencyKey: `hub:${input.hubTenantId}:${randomUUID()}`,
      reason: input.reason ?? undefined,
      trial: input.trial,
    });
    return { ok: true, prospectionTenantId: target };
  } catch (err) {
    // Plan offert côté app : Stripe ne l'écrase pas, comme prévu par le contrat.
    if (err instanceof ProspectionError && err.code === 409) {
      return { ok: true, immune: true };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
