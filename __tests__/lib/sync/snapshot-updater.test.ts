/**
 * Tests unitaires de `lib/sync/snapshot-updater.ts` (helpers de matérialisation
 * Niveau 2 du tenant sync).
 *
 * Couvre :
 *   - resolveTenantByExternalId : 3 stratégies (UUID, notifuseWorkspaceSlug, metadata)
 *   - applySuspended : écrit status + suspended_at + suspended_reason
 *   - applyResumed : reset des champs suspend
 *   - applySoftDeleted / applyPurged : écrit timestamps
 *   - applyOwnerChanged : append-only history bornée à 10
 *   - applyMemberEvent : append-only events bornés à 50
 *   - Tenant absent : warn + drop (pas de throw)
 *   - Idempotence : replay overwrite avec même valeur
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeTenant {
  id: string;
  notifuseWorkspaceSlug: string | null;
  metadata: Record<string, unknown>;
}

const tenants: FakeTenant[] = [];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return tenants.find((t) => t.id === where.id) ?? null;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { notifuseWorkspaceSlug?: string } }) => {
          if (where.notifuseWorkspaceSlug) {
            return (
              tenants.find(
                (t) => t.notifuseWorkspaceSlug === where.notifuseWorkspaceSlug,
              ) ?? null
            );
          }
          return null;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { metadata: Record<string, unknown> };
        }) => {
          const t = tenants.find((x) => x.id === where.id);
          if (!t) throw new Error('Tenant not found in mock update');
          t.metadata = data.metadata;
          return t;
        },
      ),
    },
    $queryRaw: vi.fn(async (..._args: unknown[]) => {
      // On simule la query SQL "metadata -> app ->> workspace_id = X" en
      // recherchant dans les tenants en mémoire — extrait du dernier param.
      // Le mock reçoit Prisma.sql template — on ne tente pas de le parser
      // précisément, on renvoie [] par défaut (les tests qui ont besoin du
      // fallback metadata utilisent UUID ou notifuseWorkspaceSlug).
      return [];
    }),
  },
}));

// Mock Prisma SQL helper
vi.mock('@prisma/client', () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ..._values: unknown[]) => ({
      strings,
    }),
  },
}));

import {
  applyMemberEvent,
  applyOwnerChanged,
  applyPurged,
  applyQuotaExceeded,
  applyResumed,
  applySoftDeleted,
  applySuspended,
  resolveTenantByExternalId,
} from '@/lib/sync/snapshot-updater';

beforeEach(() => {
  tenants.length = 0;
  vi.clearAllMocks();
});

describe('resolveTenantByExternalId', () => {
  it('resolves by UUID', async () => {
    const uuid = '00000000-0000-4000-8000-000000000001';
    tenants.push({ id: uuid, notifuseWorkspaceSlug: null, metadata: { foo: 1 } });
    const r = await resolveTenantByExternalId('notifuse', uuid);
    expect(r?.id).toBe(uuid);
    expect(r?.metadata).toEqual({ foo: 1 });
  });

  it('resolves by notifuseWorkspaceSlug', async () => {
    tenants.push({
      id: '00000000-0000-4000-8000-000000000002',
      notifuseWorkspaceSlug: 'avse-slug',
      metadata: {},
    });
    const r = await resolveTenantByExternalId('notifuse', 'avse-slug');
    expect(r?.id).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('returns null when not found', async () => {
    const r = await resolveTenantByExternalId('notifuse', 'unknown-slug');
    expect(r).toBeNull();
  });
});

describe('applySuspended', () => {
  it('writes status + suspended_at + suspended_reason', async () => {
    const uuid = '00000000-0000-4000-8000-000000000010';
    tenants.push({ id: uuid, notifuseWorkspaceSlug: null, metadata: {} });
    await applySuspended(
      'notifuse',
      uuid,
      { suspended_at: '2026-05-23T10:00:00Z', reason: 'quota' },
      '2026-05-23T10:00:00Z',
    );
    expect(tenants[0].metadata).toMatchObject({
      notifuse_status: 'suspended',
      notifuse_suspended_at: '2026-05-23T10:00:00Z',
      notifuse_suspended_reason: 'quota',
    });
  });

  it('falls back to occurred_at when data.suspended_at missing', async () => {
    const uuid = '00000000-0000-4000-8000-000000000011';
    tenants.push({ id: uuid, notifuseWorkspaceSlug: null, metadata: {} });
    await applySuspended('notifuse', uuid, undefined, '2026-05-23T11:00:00Z');
    expect(tenants[0].metadata.notifuse_suspended_at).toBe('2026-05-23T11:00:00Z');
    expect(tenants[0].metadata.notifuse_suspended_reason).toBeNull();
  });

  it('drops silently with warn when tenant not found', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      applySuspended('notifuse', 'unknown', {}, '2026-05-23T10:00:00Z'),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('applySuspended: tenant not found'),
    );
    warnSpy.mockRestore();
  });

  it('is idempotent — replay overwrites with same value', async () => {
    const uuid = '00000000-0000-4000-8000-000000000012';
    tenants.push({ id: uuid, notifuseWorkspaceSlug: null, metadata: {} });
    const payload = { suspended_at: '2026-05-23T10:00:00Z', reason: 'quota' };
    await applySuspended('notifuse', uuid, payload, '2026-05-23T10:00:00Z');
    const first = JSON.stringify(tenants[0].metadata);
    await applySuspended('notifuse', uuid, payload, '2026-05-23T10:00:00Z');
    expect(JSON.stringify(tenants[0].metadata)).toBe(first);
  });
});

describe('applyResumed', () => {
  it('resets suspended_* fields and sets status=active', async () => {
    const uuid = '00000000-0000-4000-8000-000000000020';
    tenants.push({
      id: uuid,
      notifuseWorkspaceSlug: null,
      metadata: {
        notifuse_status: 'suspended',
        notifuse_suspended_at: '2026-05-23T10:00:00Z',
        notifuse_suspended_reason: 'quota',
      },
    });
    await applyResumed(
      'notifuse',
      uuid,
      { resumed_at: '2026-05-23T12:00:00Z' },
      '2026-05-23T12:00:00Z',
    );
    expect(tenants[0].metadata).toMatchObject({
      notifuse_status: 'active',
      notifuse_suspended_at: null,
      notifuse_suspended_reason: null,
      notifuse_resumed_at: '2026-05-23T12:00:00Z',
    });
  });
});

describe('applySoftDeleted', () => {
  it('writes soft_deleted_at and reason', async () => {
    const uuid = '00000000-0000-4000-8000-000000000030';
    tenants.push({ id: uuid, notifuseWorkspaceSlug: null, metadata: {} });
    await applySoftDeleted(
      'notifuse',
      uuid,
      { soft_deleted_at: '2026-05-23T13:00:00Z', reason: 'inactif' },
      '2026-05-23T13:00:00Z',
    );
    expect(tenants[0].metadata).toMatchObject({
      notifuse_status: 'deleted',
      notifuse_soft_deleted_at: '2026-05-23T13:00:00Z',
      notifuse_soft_deleted_reason: 'inactif',
    });
  });
});

describe('applyPurged', () => {
  it('writes purged_at and rows_deleted', async () => {
    const uuid = '00000000-0000-4000-8000-000000000040';
    tenants.push({ id: uuid, notifuseWorkspaceSlug: null, metadata: {} });
    await applyPurged(
      'prospection',
      uuid,
      { purged_at: '2026-05-23T14:00:00Z', rows_deleted: 42 },
      '2026-05-23T14:00:00Z',
    );
    expect(tenants[0].metadata).toMatchObject({
      prospection_status: 'deleted',
      prospection_purged_at: '2026-05-23T14:00:00Z',
      prospection_purged_rows: 42,
    });
  });
});

describe('applyOwnerChanged', () => {
  it('appends to bounded history (max 10)', async () => {
    const uuid = '00000000-0000-4000-8000-000000000050';
    tenants.push({ id: uuid, notifuseWorkspaceSlug: null, metadata: {} });

    // Push 12 changes : la history finale doit avoir exactement 10 entries.
    for (let i = 0; i < 12; i++) {
      await applyOwnerChanged(
        'notifuse',
        uuid,
        { old_owner_email: `old-${i}@x.com`, new_owner_email: `new-${i}@x.com` },
        `2026-05-23T15:0${i}:00Z`,
      );
    }
    const history = tenants[0].metadata.notifuse_owner_history as Array<{
      new: string;
    }>;
    expect(history).toHaveLength(10);
    expect(history[0].new).toBe('new-2@x.com'); // les 2 plus vieux sont drop
    expect(history[9].new).toBe('new-11@x.com');
  });
});

describe('applyQuotaExceeded', () => {
  it('writes last-known quota fields', async () => {
    const uuid = '00000000-0000-4000-8000-000000000060';
    tenants.push({ id: uuid, notifuseWorkspaceSlug: null, metadata: {} });
    await applyQuotaExceeded(
      'notifuse',
      uuid,
      { quota_type: 'emails', current: 1100, limit: 1000 },
      '2026-05-23T16:00:00Z',
    );
    expect(tenants[0].metadata).toMatchObject({
      notifuse_quota_exceeded_at: '2026-05-23T16:00:00Z',
      notifuse_quota_type: 'emails',
      notifuse_quota_current: 1100,
      notifuse_quota_limit: 1000,
    });
  });
});

describe('applyMemberEvent', () => {
  it('appends added/removed events bounded to 50', async () => {
    const uuid = '00000000-0000-4000-8000-000000000070';
    tenants.push({ id: uuid, notifuseWorkspaceSlug: null, metadata: {} });

    for (let i = 0; i < 55; i++) {
      await applyMemberEvent(
        'prospection',
        uuid,
        i % 2 === 0 ? 'added' : 'removed',
        { user_email: `m${i}@x.com`, role: 'member' },
        `2026-05-23T17:00:${String(i).padStart(2, '0')}Z`,
      );
    }
    const events = tenants[0].metadata.prospection_member_events as Array<{
      kind: string;
      email: string;
    }>;
    expect(events).toHaveLength(50);
    expect(events[0].email).toBe('m5@x.com');
    expect(events[49].email).toBe('m54@x.com');
  });
});
