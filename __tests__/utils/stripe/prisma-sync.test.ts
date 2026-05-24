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
const tenantTrialUpdateManyMock = vi.fn();

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
    tenantTrial: {
      updateMany: (...a: unknown[]) => tenantTrialUpdateManyMock(...a),
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
  tenantTrialUpdateManyMock.mockResolvedValue({ count: 0 });
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

describe('manageSubscriptionStatusChange — résolution LEGACY_STRIPE_PRICE_MAPPING', () => {
  // Cf CONTRAT-BILLING.md §3.7 et ticket 2026-05-23-legacy-stripe-price-mapping.
  // La sub Stripe LIVE sub_1TUtgWRgvfRggzUNC5OjqiuU (past_due, cus_UTrPVfNjDmFie5)
  // référence des Prices v2 absents du catalogue v3. Sans mapping, le dispatcher
  // logue `[stripe-sync] Unknown stripe_price_id …` à chaque event sur la sub.

  it('avant mapping (Price ID jamais émis) : warning émis + planName=null', async () => {
    // Sub sans metadata.plan_key (typique legacy), Price ID totalement
    // inconnu (pas dans le catalogue v3 ni dans LEGACY_STRIPE_PRICE_MAPPING).
    // → priorité 3 (catalogue) échoue → warning.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({
        metadata: {},
        priceId: 'price_jamais_emis_inconnu_xyz',
        priceMetadata: {},
      }),
    );
    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    // Le warning canonique du dispatcher doit avoir été émis.
    const unknownWarnCalls = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('Unknown stripe_price_id'),
    );
    expect(unknownWarnCalls.length).toBeGreaterThan(0);

    const upsertArgs = subscriptionUpsertMock.mock.calls[0][0];
    expect(upsertArgs.create.planName).toBeNull();
    warnSpy.mockRestore();
  });

  it('avec mapping legacy : price_1SvGFY... résolu vers veridian-pro SANS warning', async () => {
    // Sub legacy v2 — pas de metadata.plan_key sur la sub ni sur le price
    // (les subs v2 n'avaient pas ces metadata posées). La résolution doit
    // tomber sur la priorité 3 (catalogue + LEGACY_STRIPE_PRICE_MAPPING)
    // et trouver veridian-pro.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({
        metadata: {},
        priceId: 'price_1SvGFYRgvfRggzUNMoGboHCU',
        priceMetadata: {},
        status: 'past_due', // état réel de la sub legacy détectée
      }),
    );
    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    // ⚠️ Invariant clé : AUCUN warning `Unknown stripe_price_id` ne doit
    // sortir pour ce Price ID — c'est précisément le but du mapping.
    const unknownWarnCalls = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('Unknown stripe_price_id'),
    );
    expect(unknownWarnCalls).toHaveLength(0);

    const upsertArgs = subscriptionUpsertMock.mock.calls[0][0];
    expect(upsertArgs.create.planName).toBe('veridian-pro');
    warnSpy.mockRestore();
  });

  it('avec mapping legacy : price_1SyXiR... (workflow credits add-on) résolu sans warning', async () => {
    // Le second item de la sub legacy — add-on metered. Même invariant :
    // pas de warning si jamais le dispatcher est appelé avec ce Price ID
    // comme item principal (cas defensive : Stripe peut réordonner les items
    // après un changement de subscription).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({
        metadata: {},
        priceId: 'price_1SyXiRRgvfRggzUNDEr7BkUj',
        priceMetadata: {},
        status: 'past_due',
      }),
    );
    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    const unknownWarnCalls = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('Unknown stripe_price_id'),
    );
    expect(unknownWarnCalls).toHaveLength(0);

    const upsertArgs = subscriptionUpsertMock.mock.calls[0][0];
    expect(upsertArgs.create.planName).toBe('veridian-pro');
    warnSpy.mockRestore();
  });

  it('metadata.plan_key prime sur le mapping legacy (priorité 1)', async () => {
    // Si un jour la sub legacy reçoit un patch metadata.plan_key manuel,
    // celui-ci doit primer sur le mapping legacy. Garde-fou que l'ordre
    // de résolution reste sub.metadata → price.metadata → catalogue+legacy.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({
        metadata: { plan_key: 'notifuse-pro' },
        priceId: 'price_1SvGFYRgvfRggzUNMoGboHCU', // legacy → veridian-pro
        priceMetadata: {},
      }),
    );
    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    const upsertArgs = subscriptionUpsertMock.mock.calls[0][0];
    // La metadata explicite gagne sur le fallback legacy.
    expect(upsertArgs.create.planName).toBe('notifuse-pro');
    warnSpy.mockRestore();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Purge tenant_trials → converted (anti-résidus trial après paiement)
//
// Cf docs/AUDIT-TRIAL-RESIDUS-2026-05-24.md + ticket
// 2026-05-23-audit-trial-residus-apres-paiement.md.
//
// Garantit la promesse Robert : "client paie = plus aucune limite". Quand
// une subscription Stripe devient active (`active`/`trialing`), TOUTES les
// lignes tenant_trials non-terminales du tenant doivent être bascullées à
// `converted` pour qu'aucun cron downstream n'envoie de mail "essai".
// ════════════════════════════════════════════════════════════════════════════

describe('manageSubscriptionStatusChange — purge tenant_trials (anti-résidus)', () => {
  it('sub active → updateMany tenant_trials state IN (eligible, trial_active, trial_ending_soon) → converted', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({ metadata: { plan_key: 'veridian-pro' }, status: 'active' }),
    );
    tenantFindFirstMock.mockResolvedValueOnce({
      id: 'tenant-paid-up',
      notifuseWorkspaceSlug: null,
      notifusePlan: 'free',
      prospectionPlan: 'freemium',
      metadata: {},
    });
    tenantTrialUpdateManyMock.mockResolvedValueOnce({ count: 2 });

    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    // La purge a été appelée une fois avec le bon filtre.
    expect(tenantTrialUpdateManyMock).toHaveBeenCalledTimes(1);
    const purgeCall = tenantTrialUpdateManyMock.mock.calls[0][0];
    expect(purgeCall.where.tenantId).toBe('tenant-paid-up');
    expect(purgeCall.where.state.in.sort()).toEqual(
      ['eligible', 'trial_active', 'trial_ending_soon'].sort(),
    );
    expect(purgeCall.data.state).toBe('converted');
  });

  it('sub canceled → AUCUNE purge (sub inactive, on garde l’état trial historique)', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({ metadata: { plan_key: 'veridian-pro' }, status: 'canceled' }),
    );
    tenantFindFirstMock.mockResolvedValueOnce({
      id: 'tenant-canceled',
      notifuseWorkspaceSlug: null,
      notifusePlan: 'pro',
      prospectionPlan: 'pro',
      metadata: {},
    });

    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, false);

    // Pas de purge — la sub n'est pas active donc le tenant n'a rien "payé".
    expect(tenantTrialUpdateManyMock).not.toHaveBeenCalled();
  });

  it('sub trialing → purge OK (Stripe natif trial = sub active aussi)', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({ metadata: { plan_key: 'veridian-pro' }, status: 'trialing' }),
    );
    tenantFindFirstMock.mockResolvedValueOnce({
      id: 'tenant-stripe-trialing',
      notifuseWorkspaceSlug: null,
      notifusePlan: 'free',
      prospectionPlan: 'freemium',
      metadata: {},
    });

    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    expect(tenantTrialUpdateManyMock).toHaveBeenCalledTimes(1);
  });

  it('purge KO (DB temporairement down) → non-bloquant : la propagation downstream continue', async () => {
    subscriptionsRetrieveMock.mockResolvedValueOnce(
      makeSub({ metadata: { plan_key: 'veridian-pro' }, status: 'active' }),
    );
    tenantFindFirstMock.mockResolvedValueOnce({
      id: 'tenant-db-down',
      notifuseWorkspaceSlug: null,
      notifusePlan: 'free',
      prospectionPlan: 'freemium',
      metadata: {},
    });
    tenantTrialUpdateManyMock.mockRejectedValueOnce(new Error('DB unavailable'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { manageSubscriptionStatusChange } = await import('@/utils/stripe/prisma-sync');
    const result = await manageSubscriptionStatusChange('sub_test_1', CUSTOMER, true);

    // L'erreur a été loggée mais n'a pas fait throw — `applied` est bien rempli.
    expect(errSpy).toHaveBeenCalled();
    const apps = result.applied.map((a) => a.app).sort();
    expect(apps).toEqual(['notifuse', 'prospection']);
    errSpy.mockRestore();
  });
});
