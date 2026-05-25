/**
 * Tests unitaires de `lib/trial/drift-detection.ts`.
 *
 * Couvre :
 *  - classifyDrift : 3 catégories (low/medium/high) + cas no-drift
 *  - detectTrialSubDrifts :
 *      * mode report-only forcé (autoFix=true → ignoré + error logged)
 *      * skip tenants sans stripe_customer_id (compteur)
 *      * exclusion des tenants soft-deleted (deletedAt IS NOT NULL)
 *      * détection des 3 catégories de drift en agrégat
 *      * stripeErrors counter quand Stripe throw
 *      * cursor pagination — pas de double-comptage entre chunks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  classifyDrift,
  detectTrialSubDrifts,
  type DriftDetectionOptions,
} from '@/lib/trial/drift-detection';

// ============================================================================
// classifyDrift — table de vérité
// ============================================================================

describe('classifyDrift', () => {
  it('returns medium for trial_active + stripe active', () => {
    expect(classifyDrift('trial_active', 'active')).toBe('medium');
    expect(classifyDrift('trial_active', 'trialing')).toBe('medium');
    expect(classifyDrift('trial_active', 'past_due')).toBe('medium');
  });

  it('returns high for expired + stripe active', () => {
    expect(classifyDrift('expired', 'active')).toBe('high');
    expect(classifyDrift('expired', 'trialing')).toBe('high');
    expect(classifyDrift('expired', 'past_due')).toBe('high');
  });

  it('returns low for converted + stripe inactive', () => {
    expect(classifyDrift('converted', 'canceled')).toBe('low');
    expect(classifyDrift('converted', 'incomplete')).toBe('low');
    expect(classifyDrift('converted', 'none')).toBe('low');
    expect(classifyDrift('converted', 'unpaid')).toBe('low');
  });

  it('returns null when there is no drift', () => {
    // converted + active = aligné, pas de drift
    expect(classifyDrift('converted', 'active')).toBeNull();
    expect(classifyDrift('converted', 'trialing')).toBeNull();
    expect(classifyDrift('converted', 'past_due')).toBeNull();
    // trial_active + canceled = pas un drift (trial en cours, user n'a juste pas payé encore)
    expect(classifyDrift('trial_active', 'canceled')).toBeNull();
    expect(classifyDrift('trial_active', 'none')).toBeNull();
    // expired + canceled = aligné, pas de drift
    expect(classifyDrift('expired', 'canceled')).toBeNull();
    expect(classifyDrift('expired', 'none')).toBeNull();
  });
});

// ============================================================================
// detectTrialSubDrifts — runner end-to-end avec mocks
// ============================================================================

interface TrialFixture {
  tenantId: string;
  app: string;
  state: 'trial_active' | 'converted' | 'expired';
}

interface TenantFixture {
  id: string;
  slug: string | null;
  notifuseWorkspaceSlug: string | null;
  userId: string; // supabaseUserId (UUID bridge)
  deletedAt: Date | null;
}

interface UserFixture {
  id: string;
  supabaseUserId: string;
  stripeCustomerId: string | null;
}

function buildMocks() {
  const trials: TrialFixture[] = [];
  const tenants: TenantFixture[] = [];
  const users: UserFixture[] = [];

  const tenantTrialFindMany = vi.fn(async (args: any) => {
    // Replique la logique de cursor (tenantId, app) ASC + take.
    let rows = trials
      .filter((t) => {
        const states: string[] = args?.where?.state?.in ?? [];
        return states.includes(t.state);
      })
      .slice()
      .sort((a, b) =>
        a.tenantId === b.tenantId
          ? a.app.localeCompare(b.app)
          : a.tenantId.localeCompare(b.tenantId),
      );

    const orCursor = args?.where?.OR as Array<any> | undefined;
    if (orCursor && Array.isArray(orCursor)) {
      // Reproduit la condition cursor : (tenantId > X) OR (tenantId = X AND app > Y).
      const tenantGt = orCursor[0]?.tenantId?.gt as string;
      const sameTenant = orCursor[1]?.tenantId as string;
      const appGt = orCursor[1]?.app?.gt as string;
      rows = rows.filter(
        (r) => r.tenantId > tenantGt || (r.tenantId === sameTenant && r.app > appGt),
      );
    }

    const take = args?.take ?? 100;
    return rows.slice(0, take).map((t) => ({
      tenantId: t.tenantId,
      app: t.app,
      state: t.state,
    }));
  });

  const tenantFindMany = vi.fn(async (args: any) => {
    // Filtre soft-deleted exclus + match sur les 3 colonnes (id/slug/notifuseWorkspaceSlug).
    const idClause = args?.where?.OR?.[0]?.id?.in as string[] | undefined;
    const slugClause = args?.where?.OR?.[1]?.slug?.in as string[] | undefined;
    const nfClause = args?.where?.OR?.[2]?.notifuseWorkspaceSlug?.in as
      | string[]
      | undefined;
    const requireNotDeleted = args?.where?.deletedAt === null;

    return tenants
      .filter((t) => (requireNotDeleted ? t.deletedAt === null : true))
      .filter(
        (t) =>
          (idClause && idClause.includes(t.id)) ||
          (slugClause && t.slug && slugClause.includes(t.slug)) ||
          (nfClause &&
            t.notifuseWorkspaceSlug &&
            nfClause.includes(t.notifuseWorkspaceSlug)),
      )
      .map((t) => ({
        id: t.id,
        slug: t.slug,
        notifuseWorkspaceSlug: t.notifuseWorkspaceSlug,
        userId: t.userId,
      }));
  });

  const userFindMany = vi.fn(async (args: any) => {
    const sids = args?.where?.supabaseUserId?.in as string[] | undefined;
    return users
      .filter((u) => sids?.includes(u.supabaseUserId))
      .map((u) => ({
        id: u.id,
        supabaseUserId: u.supabaseUserId,
        stripeCustomerId: u.stripeCustomerId,
      }));
  });

  const prisma = {
    tenantTrial: { findMany: tenantTrialFindMany },
    tenant: { findMany: tenantFindMany },
    user: { findMany: userFindMany },
  } as unknown as DriftDetectionOptions['prisma'];

  return { prisma, trials, tenants, users, tenantTrialFindMany };
}

function makeStripeMock(
  byCustomer: Record<string, Array<{ status: string }>>,
  opts: { throwForCustomer?: string } = {},
) {
  return {
    subscriptions: {
      list: vi.fn(async ({ customer }: { customer: string }) => {
        if (opts.throwForCustomer && customer === opts.throwForCustomer) {
          throw new Error('stripe boom');
        }
        return { data: (byCustomer[customer] ?? []) as any };
      }),
    },
  } as any;
}

describe('detectTrialSubDrifts', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns empty report when there are no trials', async () => {
    const { prisma } = buildMocks();
    const stripeClient = makeStripeMock({});
    const summary = await detectTrialSubDrifts({ prisma, stripeClient });
    expect(summary.totalScanned).toBe(0);
    expect(summary.driftsDetected).toBe(0);
    expect(summary.mode).toBe('report-only');
    expect(summary.errors).toEqual([]);
  });

  it('forces report-only even when autoFix=true (P0 lock)', async () => {
    const { prisma } = buildMocks();
    const stripeClient = makeStripeMock({});
    const summary = await detectTrialSubDrifts({
      prisma,
      stripeClient,
      autoFix: true,
    });
    expect(summary.mode).toBe('report-only');
    expect(summary.errors).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('auto-fix'),
      }),
    );
  });

  it('skips tenants without stripe_customer_id and counts them', async () => {
    const m = buildMocks();
    m.trials.push({ tenantId: 't-uuid-1', app: 'notifuse', state: 'trial_active' });
    m.tenants.push({
      id: 't-uuid-1',
      slug: null,
      notifuseWorkspaceSlug: null,
      userId: 'sid-1',
      deletedAt: null,
    });
    m.users.push({
      id: 'user-1',
      supabaseUserId: 'sid-1',
      stripeCustomerId: null, // never checkout
    });
    const stripeClient = makeStripeMock({});
    const summary = await detectTrialSubDrifts({
      prisma: m.prisma,
      stripeClient,
    });
    expect(summary.totalScanned).toBe(1);
    expect(summary.skippedNoStripeCustomer).toBe(1);
    expect(summary.driftsDetected).toBe(0);
    expect(stripeClient.subscriptions.list).not.toHaveBeenCalled();
  });

  it('excludes soft-deleted tenants from scan', async () => {
    const m = buildMocks();
    m.trials.push({ tenantId: 't-deleted', app: 'notifuse', state: 'trial_active' });
    m.tenants.push({
      id: 't-deleted',
      slug: null,
      notifuseWorkspaceSlug: null,
      userId: 'sid-del',
      deletedAt: new Date('2026-01-01'), // soft-deleted
    });
    m.users.push({
      id: 'user-del',
      supabaseUserId: 'sid-del',
      stripeCustomerId: 'cus_del',
    });
    const stripeClient = makeStripeMock({ cus_del: [{ status: 'active' }] });
    const summary = await detectTrialSubDrifts({
      prisma: m.prisma,
      stripeClient,
    });
    // Le trial est bien scanné, mais tenant deleted → pas de stripe_customer_id
    // résolu → skip silencieux (compté dans skippedNoStripeCustomer).
    expect(summary.totalScanned).toBe(1);
    expect(summary.skippedNoStripeCustomer).toBe(1);
    expect(summary.driftsDetected).toBe(0);
  });

  it('detects all 3 drift categories in aggregate', async () => {
    const m = buildMocks();
    // Cas 1 : medium = trial_active + Stripe active
    m.trials.push({
      tenantId: 't-medium',
      app: 'notifuse',
      state: 'trial_active',
    });
    m.tenants.push({
      id: 't-medium',
      slug: null,
      notifuseWorkspaceSlug: null,
      userId: 'sid-medium',
      deletedAt: null,
    });
    m.users.push({
      id: 'u-medium',
      supabaseUserId: 'sid-medium',
      stripeCustomerId: 'cus_medium',
    });

    // Cas 2 : low = converted + Stripe canceled
    m.trials.push({
      tenantId: 't-low',
      app: 'prospection',
      state: 'converted',
    });
    m.tenants.push({
      id: 't-low',
      slug: null,
      notifuseWorkspaceSlug: null,
      userId: 'sid-low',
      deletedAt: null,
    });
    m.users.push({
      id: 'u-low',
      supabaseUserId: 'sid-low',
      stripeCustomerId: 'cus_low',
    });

    // Cas 3 : high = expired + Stripe active
    m.trials.push({
      tenantId: 't-high',
      app: 'analytics',
      state: 'expired',
    });
    m.tenants.push({
      id: 't-high',
      slug: null,
      notifuseWorkspaceSlug: null,
      userId: 'sid-high',
      deletedAt: null,
    });
    m.users.push({
      id: 'u-high',
      supabaseUserId: 'sid-high',
      stripeCustomerId: 'cus_high',
    });

    // Bonus : un cas aligné (converted + active) qui ne doit PAS être un drift
    m.trials.push({
      tenantId: 't-ok',
      app: 'notifuse',
      state: 'converted',
    });
    m.tenants.push({
      id: 't-ok',
      slug: null,
      notifuseWorkspaceSlug: null,
      userId: 'sid-ok',
      deletedAt: null,
    });
    m.users.push({
      id: 'u-ok',
      supabaseUserId: 'sid-ok',
      stripeCustomerId: 'cus_ok',
    });

    const stripeClient = makeStripeMock({
      cus_medium: [{ status: 'active' }],
      cus_low: [{ status: 'canceled' }],
      cus_high: [{ status: 'active' }],
      cus_ok: [{ status: 'active' }],
    });

    const summary = await detectTrialSubDrifts({
      prisma: m.prisma,
      stripeClient,
    });
    expect(summary.totalScanned).toBe(4);
    expect(summary.skippedNoStripeCustomer).toBe(0);
    expect(summary.driftsDetected).toBe(3);
    const bySeverity = Object.fromEntries(
      summary.drifts.map((d) => [d.severity, d]),
    );
    expect(bySeverity.medium).toMatchObject({
      tenantId: 't-medium',
      trialState: 'trial_active',
      stripeStatus: 'active',
    });
    expect(bySeverity.low).toMatchObject({
      tenantId: 't-low',
      trialState: 'converted',
      stripeStatus: 'canceled',
    });
    expect(bySeverity.high).toMatchObject({
      tenantId: 't-high',
      trialState: 'expired',
      stripeStatus: 'active',
    });
    // Le `cus_ok` (converted+active) ne doit PAS être dans les drifts.
    expect(summary.drifts.find((d) => d.tenantId === 't-ok')).toBeUndefined();
  });

  it('counts stripeErrors when Stripe.list throws', async () => {
    const m = buildMocks();
    m.trials.push({
      tenantId: 't-boom',
      app: 'notifuse',
      state: 'trial_active',
    });
    m.tenants.push({
      id: 't-boom',
      slug: null,
      notifuseWorkspaceSlug: null,
      userId: 'sid-boom',
      deletedAt: null,
    });
    m.users.push({
      id: 'u-boom',
      supabaseUserId: 'sid-boom',
      stripeCustomerId: 'cus_boom',
    });

    const stripeClient = makeStripeMock(
      {},
      { throwForCustomer: 'cus_boom' },
    );
    const summary = await detectTrialSubDrifts({
      prisma: m.prisma,
      stripeClient,
    });
    expect(summary.totalScanned).toBe(1);
    expect(summary.stripeErrors).toBe(1);
    expect(summary.driftsDetected).toBe(0);
    expect(summary.errors[0]).toMatchObject({
      tenantId: 't-boom',
      message: expect.stringContaining('stripe_list_failed'),
    });
  });

  it('paginates via cursor without double-counting between chunks', async () => {
    const m = buildMocks();
    // 3 trials → chunkSize=1 force 3 chunks distincts.
    for (let i = 1; i <= 3; i += 1) {
      const tid = `t-${i}`;
      m.trials.push({
        tenantId: tid,
        app: 'notifuse',
        state: 'trial_active',
      });
      m.tenants.push({
        id: tid,
        slug: null,
        notifuseWorkspaceSlug: null,
        userId: `sid-${i}`,
        deletedAt: null,
      });
      m.users.push({
        id: `u-${i}`,
        supabaseUserId: `sid-${i}`,
        stripeCustomerId: `cus_${i}`,
      });
    }
    const stripeClient = makeStripeMock({
      cus_1: [{ status: 'active' }],
      cus_2: [{ status: 'active' }],
      cus_3: [{ status: 'active' }],
    });
    const summary = await detectTrialSubDrifts({
      prisma: m.prisma,
      stripeClient,
      chunkSize: 1,
    });
    expect(summary.totalScanned).toBe(3);
    expect(summary.driftsDetected).toBe(3);
    // findMany appelé 4× : 3 chunks + 1 dernier qui retourne [] pour stopper.
    // Tolérance : on accepte 3 ou 4 selon l'optimisation (chunk court arrête tôt).
    expect(m.tenantTrialFindMany.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
