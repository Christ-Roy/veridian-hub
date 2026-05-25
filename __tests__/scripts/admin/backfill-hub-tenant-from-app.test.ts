/**
 * Tests unitaires Nuclear de `scripts/admin/backfill-hub-tenant-from-app.ts`.
 *
 * Couvre :
 *   - validation input (app, tenantId UUID, email)
 *   - idempotence : si row Tenant existe → status='already_backfilled', pas
 *     d'INSERT
 *   - user_not_found : lookup user Hub miss → status='user_not_found', pas
 *     d'INSERT
 *   - dry-run : status='created' virtuel sans appeler prisma.tenant.create
 *   - execute : INSERT row Tenant avec id=tenantId, userId=user.supabaseUserId,
 *     status='active' et champs dédiés selon l'app
 *   - app=prospection vs notifuse → bons champs typed hydratés
 *   - metadata.<app> hydratée avec provisioning_source='backfill-script'
 *
 * On mocke Prisma entièrement pour isoler la logique métier. Aucune écriture
 * DB réelle. Pattern aligné avec `__tests__/lib/sync/reconcile.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  backfillHubTenantFromApp,
  type BackfillInput,
} from '@/scripts/admin/backfill-hub-tenant-from-app';

const VALID_UUID = '462a4295-8e9b-4ef1-b107-7358f1739ba8';
const OWNER_EMAIL = 'client@example.com';
const USER_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_ID = 'cuid-user-1';

function makeFakePrisma(opts: {
  existingTenant?: { id: string } | null;
  user?: { id: string; supabaseUserId: string | null } | null;
}) {
  const tenantCreate = vi.fn(async () => undefined as never);
  const tenantFindUnique = vi.fn(async () => opts.existingTenant ?? null);
  const userFindUnique = vi.fn(async () => opts.user ?? null);
  return {
    tenant: { findUnique: tenantFindUnique, create: tenantCreate },
    user: { findUnique: userFindUnique },
    _spies: { tenantCreate, tenantFindUnique, userFindUnique },
  };
}

const baseInput: BackfillInput = {
  app: 'prospection',
  tenantId: VALID_UUID,
  ownerEmail: OWNER_EMAIL,
};

describe('backfillHubTenantFromApp — validation', () => {
  it('rejects unknown app', async () => {
    const fake = makeFakePrisma({});
    const result = await backfillHubTenantFromApp(
      fake as never,
      { ...baseInput, app: 'twenty' as never },
      false,
    );
    expect(result).toEqual({
      status: 'invalid_input',
      reason: expect.stringContaining('unknown app'),
    });
    expect(fake._spies.tenantCreate).not.toHaveBeenCalled();
  });

  it('rejects invalid UUID tenantId', async () => {
    const fake = makeFakePrisma({});
    const result = await backfillHubTenantFromApp(
      fake as never,
      { ...baseInput, tenantId: 'not-a-uuid' },
      false,
    );
    expect(result).toMatchObject({
      status: 'invalid_input',
      reason: expect.stringContaining('invalid UUID'),
    });
    expect(fake._spies.tenantCreate).not.toHaveBeenCalled();
  });

  it('rejects email without @', async () => {
    const fake = makeFakePrisma({});
    const result = await backfillHubTenantFromApp(
      fake as never,
      { ...baseInput, ownerEmail: 'not-an-email' },
      false,
    );
    expect(result).toMatchObject({
      status: 'invalid_input',
      reason: expect.stringContaining('invalid email'),
    });
    expect(fake._spies.tenantCreate).not.toHaveBeenCalled();
  });

  it('accepts all 4 known apps', async () => {
    for (const app of ['notifuse', 'prospection', 'analytics', 'cms'] as const) {
      const fake = makeFakePrisma({
        existingTenant: { id: VALID_UUID }, // skip via idempotence
      });
      const result = await backfillHubTenantFromApp(
        fake as never,
        { ...baseInput, app },
        false,
      );
      expect(result.status).not.toBe('invalid_input');
    }
  });
});

describe('backfillHubTenantFromApp — idempotence', () => {
  it('returns already_backfilled when tenant row exists, no INSERT', async () => {
    const fake = makeFakePrisma({
      existingTenant: { id: VALID_UUID },
    });
    const result = await backfillHubTenantFromApp(fake as never, baseInput, true);
    expect(result).toEqual({
      status: 'already_backfilled',
      tenantId: VALID_UUID,
    });
    expect(fake._spies.tenantCreate).not.toHaveBeenCalled();
    expect(fake._spies.userFindUnique).not.toHaveBeenCalled();
  });
});

describe('backfillHubTenantFromApp — user lookup', () => {
  it('returns user_not_found when no user matches email, no INSERT', async () => {
    const fake = makeFakePrisma({
      existingTenant: null,
      user: null,
    });
    const result = await backfillHubTenantFromApp(fake as never, baseInput, true);
    expect(result).toEqual({
      status: 'user_not_found',
      email: OWNER_EMAIL,
    });
    expect(fake._spies.tenantCreate).not.toHaveBeenCalled();
  });

  it('returns user_not_found when user has no supabaseUserId (broken bridge)', async () => {
    const fake = makeFakePrisma({
      existingTenant: null,
      user: { id: USER_ID, supabaseUserId: null },
    });
    const result = await backfillHubTenantFromApp(fake as never, baseInput, true);
    expect(result.status).toBe('user_not_found');
    expect(fake._spies.tenantCreate).not.toHaveBeenCalled();
  });
});

describe('backfillHubTenantFromApp — dry-run mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns status=created without calling prisma.tenant.create', async () => {
    const fake = makeFakePrisma({
      existingTenant: null,
      user: { id: USER_ID, supabaseUserId: USER_UUID },
    });
    const result = await backfillHubTenantFromApp(fake as never, baseInput, false);
    expect(result).toEqual({
      status: 'created',
      tenantId: VALID_UUID,
      userUuid: USER_UUID,
      userId: USER_ID,
    });
    expect(fake._spies.tenantCreate).not.toHaveBeenCalled();
  });
});

describe('backfillHubTenantFromApp — execute mode (write)', () => {
  it('INSERTs Tenant row with prospection dedicated fields', async () => {
    const fake = makeFakePrisma({
      existingTenant: null,
      user: { id: USER_ID, supabaseUserId: USER_UUID },
    });
    const result = await backfillHubTenantFromApp(fake as never, baseInput, true);
    expect(result.status).toBe('created');
    expect(fake._spies.tenantCreate).toHaveBeenCalledTimes(1);

    const callArgs = fake._spies.tenantCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(callArgs.data.id).toBe(VALID_UUID);
    expect(callArgs.data.userId).toBe(USER_UUID);
    expect(callArgs.data.status).toBe('active');
    expect(callArgs.data.slug).toBe(`backfill-prospection-${VALID_UUID}`);
    expect(callArgs.data.prospectionPlan).toBe('freemium');
    expect(callArgs.data.prospectionProvisionedAt).toBeInstanceOf(Date);
    // pas de notifuse-specific fields
    expect(callArgs.data.notifusePlan).toBeUndefined();
  });

  it('INSERTs Tenant row with notifuse dedicated fields', async () => {
    const fake = makeFakePrisma({
      existingTenant: null,
      user: { id: USER_ID, supabaseUserId: USER_UUID },
    });
    const result = await backfillHubTenantFromApp(
      fake as never,
      { ...baseInput, app: 'notifuse' },
      true,
    );
    expect(result.status).toBe('created');
    const callArgs = fake._spies.tenantCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(callArgs.data.notifusePlan).toBe('free');
    expect(callArgs.data.notifuseWorkspaceSlug).toBeNull();
    // pas de prospection-specific fields
    expect(callArgs.data.prospectionPlan).toBeUndefined();
  });

  it('INSERTs Tenant with empty dedicated fields for analytics / cms', async () => {
    for (const app of ['analytics', 'cms'] as const) {
      const fake = makeFakePrisma({
        existingTenant: null,
        user: { id: USER_ID, supabaseUserId: USER_UUID },
      });
      await backfillHubTenantFromApp(fake as never, { ...baseInput, app }, true);
      const callArgs = fake._spies.tenantCreate.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(callArgs.data.notifusePlan).toBeUndefined();
      expect(callArgs.data.prospectionPlan).toBeUndefined();
      // metadata.<app> doit quand même être présent
      expect((callArgs.data.metadata as Record<string, unknown>)[app]).toBeDefined();
    }
  });

  it('hydrates metadata.<app> with provisioning_source=backfill-script', async () => {
    const fake = makeFakePrisma({
      existingTenant: null,
      user: { id: USER_ID, supabaseUserId: USER_UUID },
    });
    await backfillHubTenantFromApp(fake as never, baseInput, true);
    const callArgs = fake._spies.tenantCreate.mock.calls[0][0] as {
      data: { metadata: Record<string, Record<string, unknown>> };
    };
    const meta = callArgs.data.metadata.prospection;
    expect(meta.provisioning_source).toBe('backfill-script');
    expect(meta.external_tenant_id).toBe(VALID_UUID);
    expect(meta.owner_email).toBe(OWNER_EMAIL);
    expect(typeof meta.backfilled_at).toBe('string');
  });
});

describe('backfillHubTenantFromApp — sécurité', () => {
  it('NEVER calls prisma.tenant.create in dry-run mode (even with all happy path inputs)', async () => {
    const fake = makeFakePrisma({
      existingTenant: null,
      user: { id: USER_ID, supabaseUserId: USER_UUID },
    });
    await backfillHubTenantFromApp(fake as never, baseInput, false);
    expect(fake._spies.tenantCreate).not.toHaveBeenCalled();
  });

  it('NEVER calls prisma.tenant.create when input is invalid', async () => {
    const fake = makeFakePrisma({
      existingTenant: null,
      user: { id: USER_ID, supabaseUserId: USER_UUID },
    });
    await backfillHubTenantFromApp(
      fake as never,
      { ...baseInput, tenantId: 'broken' },
      true,
    );
    expect(fake._spies.tenantCreate).not.toHaveBeenCalled();
  });
});
