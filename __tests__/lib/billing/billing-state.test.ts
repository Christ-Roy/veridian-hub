/**
 * Tests unitaires de `lib/billing/billing-state.ts` — mapping v1 → v2,
 * cache 10s TTL, lookup tenant.
 *
 * Couvre :
 *   - mapPlanSource : 4 enum v2 calculés depuis (v1 source, plan, sub_id, trial)
 *   - normalizePlan : 'freemium' → 'free', noms inconnus → null
 *   - getBillingState : tenant_not_found, unknown_plan, shape, cache TTL
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const tenantFindUniqueMock = vi.fn();
const tenantTrialFindUniqueMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findUnique: (...args: unknown[]) => tenantFindUniqueMock(...args),
    },
    tenantTrial: {
      findUnique: (...args: unknown[]) => tenantTrialFindUniqueMock(...args),
    },
  },
}));

import {
  getBillingState,
  clearBillingStateCache,
  billingStateCacheSize,
  __test,
} from '@/lib/billing/billing-state';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  tenantFindUniqueMock.mockReset();
  tenantTrialFindUniqueMock.mockReset();
  clearBillingStateCache();
});

describe('mapPlanSource — mapping v1 → v2', () => {
  const { mapPlanSource } = __test;

  it('manual / lifetime_* / internal → grant_manual', () => {
    for (const v1 of ['manual', 'lifetime_site_vitrine', 'lifetime_partner', 'internal']) {
      expect(
        mapPlanSource({
          planSourceV1: v1,
          plan: 'pro',
          stripeSubscriptionId: null,
          trialState: null,
        }),
      ).toBe('grant_manual');
    }
  });

  it('grant_manual prend précédence même si sub Stripe présente', () => {
    // Cas safety: tenant lifetime qui aurait quand même une sub Stripe (rare,
    // probablement bug data) → on garde grant_manual pour respecter
    // l'invariant §3.3 (immunité Stripe).
    expect(
      mapPlanSource({
        planSourceV1: 'lifetime_partner',
        plan: 'pro',
        stripeSubscriptionId: 'sub_xyz',
        trialState: null,
      }),
    ).toBe('grant_manual');
  });

  it('trial_active + pas de sub → stripe_trial', () => {
    expect(
      mapPlanSource({
        planSourceV1: 'stripe',
        plan: 'pro',
        stripeSubscriptionId: null,
        trialState: 'trial_active',
      }),
    ).toBe('stripe_trial');
  });

  it('trial_ending_soon + pas de sub → stripe_trial', () => {
    expect(
      mapPlanSource({
        planSourceV1: 'stripe',
        plan: 'pro',
        stripeSubscriptionId: null,
        trialState: 'trial_ending_soon',
      }),
    ).toBe('stripe_trial');
  });

  it('trial_active + sub présente (conversion) → stripe (pas stripe_trial)', () => {
    // Le trial s'est converti : sub Stripe payante a pris le relais.
    // On doit dire 'stripe' à l'app, pas 'stripe_trial' (sinon l'app
    // afficherait "essai gratuit" alors que le user paie).
    expect(
      mapPlanSource({
        planSourceV1: 'stripe',
        plan: 'pro',
        stripeSubscriptionId: 'sub_xyz',
        trialState: 'trial_active',
      }),
    ).toBe('stripe');
  });

  it('plan=free + trial expired → downgrade_auto', () => {
    expect(
      mapPlanSource({
        planSourceV1: 'stripe',
        plan: 'free',
        stripeSubscriptionId: null,
        trialState: 'expired',
      }),
    ).toBe('downgrade_auto');
  });

  it('plan=free + ex-stripe annulée (sub_id null) → downgrade_auto', () => {
    expect(
      mapPlanSource({
        planSourceV1: 'stripe',
        plan: 'free',
        stripeSubscriptionId: null,
        trialState: null,
      }),
    ).toBe('downgrade_auto');
  });

  it('plan=free + plan_source manual (jamais payé) → grant_manual', () => {
    // Un tenant sans historique Stripe — c'est un "free natif". On respecte
    // grant_manual (l'admin a posé le plan free) plutôt que downgrade_auto.
    expect(
      mapPlanSource({
        planSourceV1: 'manual',
        plan: 'free',
        stripeSubscriptionId: null,
        trialState: null,
      }),
    ).toBe('grant_manual');
  });

  it('plan payant + sub présente → stripe', () => {
    expect(
      mapPlanSource({
        planSourceV1: 'stripe',
        plan: 'pro',
        stripeSubscriptionId: 'sub_xyz',
        trialState: null,
      }),
    ).toBe('stripe');
  });
});

describe('normalizePlan', () => {
  const { normalizePlan } = __test;

  it('freemium → free (alias Prospection)', () => {
    expect(normalizePlan('freemium')).toBe('free');
  });

  it('plans canoniques passent tels quels', () => {
    expect(normalizePlan('free')).toBe('free');
    expect(normalizePlan('pro')).toBe('pro');
    expect(normalizePlan('business')).toBe('business');
    expect(normalizePlan('enterprise')).toBe('enterprise');
  });

  it('case-insensitive', () => {
    expect(normalizePlan('PRO')).toBe('pro');
    expect(normalizePlan(' Business ')).toBe('business');
  });

  it('plan inconnu → null', () => {
    expect(normalizePlan('garbage')).toBeNull();
    expect(normalizePlan('')).toBeNull();
    expect(normalizePlan(null)).toBeNull();
    expect(normalizePlan(undefined)).toBeNull();
  });
});

describe('readEffectiveAt', () => {
  const { readEffectiveAt } = __test;
  const fallback = new Date('2026-05-01T00:00:00.000Z');

  it("lit metadata.<app>_plan_set_at si présent", () => {
    const d = readEffectiveAt(
      { notifuse_plan_set_at: '2026-05-15T12:00:00.000Z' },
      'notifuse',
      fallback,
    );
    expect(d.toISOString()).toBe('2026-05-15T12:00:00.000Z');
  });

  it('fallback si pas de metadata', () => {
    expect(readEffectiveAt(null, 'notifuse', fallback)).toBe(fallback);
  });

  it('fallback si date invalide', () => {
    expect(
      readEffectiveAt({ notifuse_plan_set_at: 'pas-une-date' }, 'notifuse', fallback),
    ).toBe(fallback);
  });

  it('isole par app — prospection ne lit pas notifuse_plan_set_at', () => {
    const d = readEffectiveAt(
      { notifuse_plan_set_at: '2026-05-15T12:00:00.000Z' },
      'prospection',
      fallback,
    );
    expect(d).toBe(fallback);
  });
});

describe('getBillingState — intégration mock prisma', () => {
  it('404 si tenant inconnu', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce(null);
    const res = await getBillingState(VALID_UUID, 'notifuse');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tenant_not_found');
    }
  });

  it('shape conforme §6.3 pour un tenant notifuse pro stripe', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      notifusePlan: 'pro',
      prospectionPlan: 'freemium',
      metadata: {
        notifuse_plan_source: 'stripe',
        notifuse_plan_set_at: '2026-05-20T10:00:00.000Z',
      },
      updatedAt: new Date('2026-05-22T15:30:00.000Z'),
      subscription: { stripeSubscriptionId: 'sub_test123' },
    });
    tenantTrialFindUniqueMock.mockResolvedValueOnce(null);

    const res = await getBillingState(VALID_UUID, 'notifuse');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response).toEqual({
      tenant_id: VALID_UUID,
      plan: 'pro',
      plan_source: 'stripe',
      stripe_subscription_id: 'sub_test123',
      effective_at: '2026-05-20T10:00:00.000Z',
      updated_at: '2026-05-22T15:30:00.000Z',
    });
    expect(res.cached).toBe(false);
  });

  it('lit prospectionPlan pour app=prospection (privacy / isolation app)', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      notifusePlan: 'pro',
      prospectionPlan: 'business',
      metadata: { prospection_plan_source: 'stripe' },
      updatedAt: new Date('2026-05-22T15:30:00.000Z'),
      subscription: { stripeSubscriptionId: 'sub_xyz' },
    });
    tenantTrialFindUniqueMock.mockResolvedValueOnce(null);

    const res = await getBillingState(VALID_UUID, 'prospection');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.plan).toBe('business');
    expect(res.response.plan_source).toBe('stripe');
  });

  it('stripe_trial dérivé du TenantTrial state', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      notifusePlan: 'pro',
      prospectionPlan: 'freemium',
      metadata: { notifuse_plan_source: 'stripe' },
      updatedAt: new Date('2026-05-22T15:30:00.000Z'),
      subscription: null, // pas de sub Stripe pendant trial
    });
    tenantTrialFindUniqueMock.mockResolvedValueOnce({ state: 'trial_active' });

    const res = await getBillingState(VALID_UUID, 'notifuse');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.plan_source).toBe('stripe_trial');
    expect(res.response.stripe_subscription_id).toBeNull();
  });

  it('plan inconnu → unknown_plan error', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      notifusePlan: 'garbage-plan',
      prospectionPlan: 'freemium',
      metadata: {},
      updatedAt: new Date('2026-05-22T15:30:00.000Z'),
      subscription: null,
    });
    tenantTrialFindUniqueMock.mockResolvedValueOnce(null);

    const res = await getBillingState(VALID_UUID, 'notifuse');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('unknown_plan');
  });

  it('cache HIT sur 2e appel dans la fenêtre 10s', async () => {
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      notifusePlan: 'pro',
      prospectionPlan: 'freemium',
      metadata: { notifuse_plan_source: 'stripe' },
      updatedAt: new Date('2026-05-22T15:30:00.000Z'),
      subscription: { stripeSubscriptionId: 'sub_x' },
    });
    tenantTrialFindUniqueMock.mockResolvedValueOnce(null);

    const t0 = Date.now();
    const r1 = await getBillingState(VALID_UUID, 'notifuse', { nowMs: t0 });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.cached).toBe(false);

    // 2e appel 5s plus tard, mocks pas re-armés → si on hit DB, ça throw.
    const r2 = await getBillingState(VALID_UUID, 'notifuse', { nowMs: t0 + 5_000 });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.cached).toBe(true);
    expect(tenantFindUniqueMock).toHaveBeenCalledTimes(1);
    expect(tenantTrialFindUniqueMock).toHaveBeenCalledTimes(1);
  });

  it('cache MISS après expiration TTL 10s', async () => {
    const tenantData = {
      id: VALID_UUID,
      notifusePlan: 'pro',
      prospectionPlan: 'freemium',
      metadata: { notifuse_plan_source: 'stripe' },
      updatedAt: new Date('2026-05-22T15:30:00.000Z'),
      subscription: { stripeSubscriptionId: 'sub_x' },
    };
    tenantFindUniqueMock.mockResolvedValue(tenantData);
    tenantTrialFindUniqueMock.mockResolvedValue(null);

    const t0 = Date.now();
    await getBillingState(VALID_UUID, 'notifuse', { nowMs: t0 });
    // T+10001ms → expiré (TTL = 10_000 strict)
    const r2 = await getBillingState(VALID_UUID, 'notifuse', { nowMs: t0 + 10_001 });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.cached).toBe(false);
    expect(tenantFindUniqueMock).toHaveBeenCalledTimes(2);
  });

  it('cache isolé par (tenantId, app) — notifuse et prospection ne partagent pas', async () => {
    const tenantData = {
      id: VALID_UUID,
      notifusePlan: 'pro',
      prospectionPlan: 'business',
      metadata: {
        notifuse_plan_source: 'stripe',
        prospection_plan_source: 'manual',
      },
      updatedAt: new Date('2026-05-22T15:30:00.000Z'),
      subscription: { stripeSubscriptionId: 'sub_x' },
    };
    tenantFindUniqueMock.mockResolvedValue(tenantData);
    tenantTrialFindUniqueMock.mockResolvedValue(null);

    const r1 = await getBillingState(VALID_UUID, 'notifuse');
    const r2 = await getBillingState(VALID_UUID, 'prospection');

    expect(r1.ok && r2.ok).toBe(true);
    expect(tenantFindUniqueMock).toHaveBeenCalledTimes(2);
    expect(billingStateCacheSize()).toBe(2);
  });

  it('skipCache bypasse le cache même si entry présente', async () => {
    const tenantData = {
      id: VALID_UUID,
      notifusePlan: 'pro',
      prospectionPlan: 'freemium',
      metadata: { notifuse_plan_source: 'stripe' },
      updatedAt: new Date('2026-05-22T15:30:00.000Z'),
      subscription: { stripeSubscriptionId: 'sub_x' },
    };
    tenantFindUniqueMock.mockResolvedValue(tenantData);
    tenantTrialFindUniqueMock.mockResolvedValue(null);

    await getBillingState(VALID_UUID, 'notifuse');
    await getBillingState(VALID_UUID, 'notifuse', { skipCache: true });
    expect(tenantFindUniqueMock).toHaveBeenCalledTimes(2);
  });
});
