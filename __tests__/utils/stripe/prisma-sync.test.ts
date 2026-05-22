/**
 * Tests `manageSubscriptionStatusChange` (utils/stripe/prisma-sync.ts).
 *
 * Focus : la résolution du PlanKey à 3 sources, ajoutée au sprint billing
 * (2026-05-22). Le webhook Stripe doit retrouver le plan dans cet ordre :
 *   1. metadata.plan_key de la subscription (posée au checkout)
 *   2. metadata.veridian_plan du Price / Product Stripe (posée par
 *      scripts/admin/setup-stripe-prices.ts)
 *   3. catalogue lib/pricing/plans.ts via getPlanByStripePriceId
 *
 * Couvre aussi : propagation bundle → 2 apps, et le downgrade quand la
 * subscription est inactive.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks Prisma ───────────────────────────────────────────────────────────

const subscriptionFindFirstMock = vi.fn();
const subscriptionUpsertMock = vi.fn();
const userUpdateManyMock = vi.fn();
const tenantFindFirstMock = vi.fn();
const tenantUpdateMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    subscription: {
      findFirst: (...a: unknown[]) => subscriptionFindFirstMock(...a),
      upsert: (...a: unknown[]) => subscriptionUpsertMock(...a),
    },
    user: {
      updateMany: (...a: unknown[]) => userUpdateManyMock(...a),
    },
    tenant: {
      findFirst: (...a: unknown[]) => tenantFindFirstMock(...a),
      update: (...a: unknown[]) => tenantUpdateMock(...a),
    },
  },
}));

// ─── Mocks Stripe ───────────────────────────────────────────────────────────

const subscriptionsRetrieveMock = vi.fn();
const customersRetrieveMock = vi.fn();

vi.mock('@/utils/stripe/config', () => ({
  stripe: {
    subscriptions: { retrieve: (...a: unknown[]) => subscriptionsRetrieveMock(...a) },
    customers: { retrieve: (...a: unknown[]) => customersRetrieveMock(...a) },
  },
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────

const UUID = 'user-uuid-1';
const CUSTOMER = 'cus_test_1';

/** Subscription Stripe minimale, le `metadata` et le `price` sont surchargeables. */
function makeSub(overrides: {
  metadata?: Record<string, string>;
  priceId?: string;
  priceMetadata?: Record<string, string>;
  productMetadata?: Record<string, string>;
  status?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'sub_test_1',
    customer: CUSTOMER,
    status: overrides.status ?? 'active',
    metadata: overrides.metadata ?? {},
    items: {
      data: [
        {
          price: {
            id: overrides.priceId ?? 'price_test_1',
            metadata: overrides.priceMetadata ?? {},
            product:
              overrides.productMetadata !== undefined
                ? { id: 'prod_1', metadata: overrides.productMetadata }
                : 'prod_1',
          },
        },
      ],
    },
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    current_period_start: now,
    current_period_end: now + 2_592_000,
    created: now,
    ended_at: null,
    trial_start: null,
    trial_end: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Resolve UUID : findFirst subscription renvoie le user lié.
  subscriptionFindFirstMock.mockResolvedValue({ userId: UUID });
  subscriptionUpsertMock.mockResolvedValue({});
  userUpdateManyMock.mockResolvedValue({ count: 0 });
  // Par défaut : pas de tenant → la propagation s'arrête tôt, on teste juste
  // la résolution du planKey via la subscription persistée.
  tenantFindFirstMock.mockResolvedValue(null);
  tenantUpdateMock.mockResolvedValue({});
});

describe('manageSubscriptionStatusChange — résolution du PlanKey', () => {
  it('priorité 1 : metadata.plan_key de la subscription', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({ metadata: { plan_key: 'notifuse-pro' }, priceId: 'price_x' }),
    );
    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    const upsertArgs = subscriptionUpsertMock.mock.calls[0][0];
    // planName persisté = la PlanKey résolue.
    expect(upsertArgs.create.planName).toBe('notifuse-pro');
  });

  it('priorité 2 : metadata.veridian_plan du Price quand pas de plan_key sub', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({
        metadata: {},
        priceId: 'price_unknown',
        priceMetadata: { veridian_plan: 'notifuse-business', interval: 'month' },
      }),
    );
    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    const upsertArgs = subscriptionUpsertMock.mock.calls[0][0];
    expect(upsertArgs.create.planName).toBe('notifuse-business');
  });

  it('priorité 2bis : metadata.veridian_plan du Product (price sans metadata)', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({
        metadata: {},
        priceId: 'price_unknown',
        priceMetadata: {},
        productMetadata: { veridian_plan: 'veridian-pro' },
      }),
    );
    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    const upsertArgs = subscriptionUpsertMock.mock.calls[0][0];
    expect(upsertArgs.create.planName).toBe('veridian-pro');
  });

  it('metadata.plan_key prime sur metadata.veridian_plan du Price', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({
        metadata: { plan_key: 'notifuse-pro' },
        priceMetadata: { veridian_plan: 'notifuse-business' },
      }),
    );
    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    const upsertArgs = subscriptionUpsertMock.mock.calls[0][0];
    // La metadata explicite de la subscription gagne.
    expect(upsertArgs.create.planName).toBe('notifuse-pro');
  });

  it('aucune source → planName null, pas de crash', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({ metadata: {}, priceId: 'price_inconnu', priceMetadata: {} }),
    );
    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    const result = await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    const upsertArgs = subscriptionUpsertMock.mock.calls[0][0];
    expect(upsertArgs.create.planName).toBeNull();
    // Sans planKey, la propagation ne fait rien.
    expect(result.applied).toEqual([]);
  });
});

describe('manageSubscriptionStatusChange — propagation bundle = 2 apps', () => {
  it('un bundle veridian-pro touche notifuse ET prospection', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({ metadata: { plan_key: 'veridian-pro' } }),
    );
    tenantFindFirstMock.mockResolvedValueOnce({
      id: 'tenant-1',
      notifuseWorkspaceSlug: null, // pas de propagation HMAC, juste la DB
      notifusePlan: 'free',
      prospectionPlan: 'freemium',
      metadata: {},
    });

    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    const result = await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    // Les 2 apps sont dans `applied`.
    const apps = result.applied.map((a) => a.app).sort();
    expect(apps).toEqual(['notifuse', 'prospection']);
    // Le tenant DB est passé en pro sur les 2 apps.
    const tenantUpdateArgs = tenantUpdateMock.mock.calls[0][0];
    expect(tenantUpdateArgs.data.notifusePlan).toBe('pro');
    expect(tenantUpdateArgs.data.prospectionPlan).toBe('pro');
  });

  it('subscription annulée → downgrade tenant free/freemium', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({ metadata: { plan_key: 'veridian-pro' }, status: 'canceled' }),
    );
    tenantFindFirstMock.mockResolvedValueOnce({
      id: 'tenant-1',
      notifuseWorkspaceSlug: null,
      notifusePlan: 'pro',
      prospectionPlan: 'pro',
      metadata: {},
    });

    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, false);

    const tenantUpdateArgs = tenantUpdateMock.mock.calls[0][0];
    expect(tenantUpdateArgs.data.notifusePlan).toBe('free');
    expect(tenantUpdateArgs.data.prospectionPlan).toBe('freemium');
  });

  it('tenant immune (lifetime) → notifusePlan jamais downgradé par Stripe', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({ metadata: { plan_key: 'notifuse-pro' }, status: 'canceled' }),
    );
    tenantFindFirstMock.mockResolvedValueOnce({
      id: 'tenant-1',
      notifuseWorkspaceSlug: null,
      notifusePlan: 'business',
      prospectionPlan: 'pro',
      metadata: { notifuse_plan_source: 'lifetime_partner' },
    });

    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    const result = await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, false);

    const tenantUpdateArgs = tenantUpdateMock.mock.calls[0][0];
    // Notifuse immune → garde son plan business malgré subscription canceled.
    expect(tenantUpdateArgs.data.notifusePlan).toBe('business');
    const notifuseApplied = result.applied.find((a) => a.app === 'notifuse');
    expect(notifuseApplied?.immune).toBe(true);
  });
});
