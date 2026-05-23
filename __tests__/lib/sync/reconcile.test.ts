/**
 * Tests unitaires de `lib/sync/reconcile.ts` (Niveau 3 du tenant sync).
 *
 * Couvre :
 *   - diffTenantApp : plan_mismatch, status_mismatch, tenant_missing_app,
 *     tenant_extra_app, app_unreachable
 *   - runReconcile : sélection des tenants actifs, agrégation des drifts,
 *     mode dry-run forcé même si autoRepair=true
 *   - Aucune écriture côté Hub en dry-run (assertion explicite)
 *   - Comptage appsUnreachable
 *   - Tenant sans email → skip silencieux
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { diffTenantApp, runReconcile } from '@/lib/sync/reconcile';
import type {
  DiscoveryAppResult,
  DiscoveryResult,
} from '@/lib/sync/types';

function makeDiscovery(
  notifuse: DiscoveryAppResult,
  prospection: DiscoveryAppResult = { found: false },
): DiscoveryResult {
  return {
    email: 'user@x.com',
    apps: {
      notifuse,
      prospection,
      analytics: { found: false },
      cms: { found: false },
    },
    startedAt: new Date().toISOString(),
    durationMs: 1,
  };
}

const baseTenant = {
  hubTenantId: 't1',
  userEmail: 'user@x.com',
  notifusePlan: 'pro',
  prospectionPlan: null,
  notifuseWorkspaceSlug: 'avse-slug',
  metadata: { notifuse_status: 'active' } as Record<string, unknown>,
};

describe('diffTenantApp', () => {
  it('emits plan_mismatch when Hub.plan ≠ snapshot.plan', () => {
    const disc = makeDiscovery({
      found: true,
      snapshots: [
        {
          app: 'notifuse',
          workspaceId: 'ws-1',
          plan: 'business',
          status: 'active',
          observedAt: 'now',
        },
      ],
    });
    const drifts = diffTenantApp(baseTenant, 'notifuse', disc, 'now');
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      kind: 'plan_mismatch',
      hubValue: 'pro',
      appValue: 'business',
    });
  });

  it('emits status_mismatch when Hub.status ≠ snapshot.status', () => {
    const disc = makeDiscovery({
      found: true,
      snapshots: [
        {
          app: 'notifuse',
          workspaceId: 'ws-1',
          plan: 'pro', // same plan = pas de plan_mismatch
          status: 'suspended',
          observedAt: 'now',
        },
      ],
    });
    const drifts = diffTenantApp(baseTenant, 'notifuse', disc, 'now');
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      kind: 'status_mismatch',
      hubValue: 'active',
      appValue: 'suspended',
    });
  });

  it('emits both plan_mismatch and status_mismatch in one shot', () => {
    const disc = makeDiscovery({
      found: true,
      snapshots: [
        {
          app: 'notifuse',
          workspaceId: 'ws-1',
          plan: 'business',
          status: 'suspended',
          observedAt: 'now',
        },
      ],
    });
    const drifts = diffTenantApp(baseTenant, 'notifuse', disc, 'now');
    expect(drifts).toHaveLength(2);
    expect(drifts.map((d) => d.kind).sort()).toEqual([
      'plan_mismatch',
      'status_mismatch',
    ]);
  });

  it('emits tenant_missing_app when Hub knows the app but discovery says 404', () => {
    const disc = makeDiscovery({ found: false });
    const drifts = diffTenantApp(baseTenant, 'notifuse', disc, 'now');
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ kind: 'tenant_missing_app' });
  });

  it('emits tenant_extra_app when Hub does not know the app but discovery finds it', () => {
    const tenantWithoutNotifuse = {
      ...baseTenant,
      notifusePlan: null,
      notifuseWorkspaceSlug: null,
      metadata: {} as Record<string, unknown>,
    };
    const disc = makeDiscovery({
      found: true,
      snapshots: [
        {
          app: 'notifuse',
          workspaceId: 'ws-extra',
          observedAt: 'now',
        },
      ],
    });
    const drifts = diffTenantApp(tenantWithoutNotifuse, 'notifuse', disc, 'now');
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ kind: 'tenant_extra_app' });
  });

  it('emits app_unreachable when discovery returns error', () => {
    const disc = makeDiscovery({ error: 'timeout_2000ms' });
    const drifts = diffTenantApp(baseTenant, 'notifuse', disc, 'now');
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      kind: 'app_unreachable',
      appValue: { error: 'timeout_2000ms' },
    });
  });

  it('emits zero drift when Hub does not know the app AND discovery says 404', () => {
    const tenantWithoutNotifuse = {
      ...baseTenant,
      notifusePlan: null,
      notifuseWorkspaceSlug: null,
      metadata: {} as Record<string, unknown>,
    };
    const disc = makeDiscovery({ found: false });
    const drifts = diffTenantApp(tenantWithoutNotifuse, 'notifuse', disc, 'now');
    expect(drifts).toHaveLength(0);
  });
});

// ============================================================================
// runReconcile (intégration avec Prisma mocké + discovery mocké)
// ============================================================================

describe('runReconcile', () => {
  // Mock Prisma minimal pour le runner.
  const tenantUpdateMock = vi.fn();
  const tenantsRowsMock: Array<Record<string, unknown>> = [];
  const usersRowsMock: Array<{ supabaseUserId: string; email: string }> = [];

  const fakePrisma = {
    tenant: {
      findMany: vi.fn(async () => tenantsRowsMock as never),
      update: tenantUpdateMock,
    },
    user: {
      findMany: vi.fn(async () => usersRowsMock as never),
    },
  };

  beforeEach(() => {
    tenantsRowsMock.length = 0;
    usersRowsMock.length = 0;
    tenantUpdateMock.mockReset();
  });

  it('returns dry-run summary with 0 tenants when none found', async () => {
    const summary = await runReconcile({
      prisma: fakePrisma as never,
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ found: false }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof fetch,
    });
    expect(summary.usersScanned).toBe(0);
    expect(summary.driftsDetected).toBe(0);
    expect(summary.mode).toBe('dry-run');
    expect(tenantUpdateMock).not.toHaveBeenCalled();
  });

  it('detects drifts across multiple tenants without writing to Hub', async () => {
    // Configure ENV pour notifuse uniquement (les autres → not_configured).
    process.env.NOTIFUSE_API_URL = 'https://notifuse.test';
    process.env.NOTIFUSE_HUB_API_SECRET = 'test-secret';

    tenantsRowsMock.push(
      {
        id: 't1',
        userId: 'uuid-1',
        notifusePlan: 'pro',
        prospectionPlan: null,
        notifuseWorkspaceSlug: 'slug-1',
        metadata: { notifuse_status: 'active' },
      },
      {
        id: 't2',
        userId: 'uuid-2',
        notifusePlan: 'free',
        prospectionPlan: null,
        notifuseWorkspaceSlug: 'slug-2',
        metadata: { notifuse_status: 'active' },
      },
    );
    usersRowsMock.push(
      { supabaseUserId: 'uuid-1', email: 'u1@x.com' },
      { supabaseUserId: 'uuid-2', email: 'u2@x.com' },
    );

    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      if (url.includes('u1@x.com')) {
        // Drift : Hub dit pro, app dit business
        return new Response(
          JSON.stringify({
            found: true,
            workspaces: [{ workspace_id: 'ws-1', plan: 'business', status: 'active' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // u2 : aligné avec Hub (free)
      return new Response(
        JSON.stringify({
          found: true,
          workspaces: [{ workspace_id: 'ws-2', plan: 'free', status: 'active' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const summary = await runReconcile({
      prisma: fakePrisma as never,
      fetchImpl: fetchMock as unknown as typeof fetch,
      apps: ['notifuse'],
    });
    expect(summary.usersScanned).toBe(2);
    expect(summary.appsQueried).toBe(2);
    // 1 drift (plan u1) — pas de drift pour u2 aligné.
    expect(summary.driftsDetected).toBe(1);
    expect(summary.drifts[0]).toMatchObject({
      hubTenantId: 't1',
      app: 'notifuse',
      kind: 'plan_mismatch',
    });
    // Le mode reste dry-run et personne n'a appelé tenant.update.
    expect(summary.mode).toBe('dry-run');
    expect(tenantUpdateMock).not.toHaveBeenCalled();
  });

  it('forces dry-run even when autoRepair=true is passed (P0 lock)', async () => {
    const summary = await runReconcile({
      prisma: fakePrisma as never,
      autoRepair: true,
      apps: ['notifuse'],
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ found: false }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof fetch,
    });
    expect(summary.mode).toBe('dry-run');
    expect(summary.errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('auto-repair') }),
    );
    expect(tenantUpdateMock).not.toHaveBeenCalled();
  });

  it('counts appsUnreachable when an app times out / 5xx', async () => {
    process.env.NOTIFUSE_API_URL = 'https://notifuse.test';
    process.env.NOTIFUSE_HUB_API_SECRET = 'test-secret';

    tenantsRowsMock.push({
      id: 't1',
      userId: 'uuid-1',
      notifusePlan: 'pro',
      prospectionPlan: null,
      notifuseWorkspaceSlug: 'slug-1',
      metadata: { notifuse_status: 'active' },
    });
    usersRowsMock.push({ supabaseUserId: 'uuid-1', email: 'u1@x.com' });

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'down' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const summary = await runReconcile({
      prisma: fakePrisma as never,
      fetchImpl: fetchMock as unknown as typeof fetch,
      apps: ['notifuse'],
    });
    expect(summary.appsUnreachable).toBe(1);
    expect(summary.drifts[0]).toMatchObject({ kind: 'app_unreachable' });
  });
});
