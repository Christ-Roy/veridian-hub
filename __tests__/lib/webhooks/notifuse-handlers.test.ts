/**
 * Tests des handlers v1.4 du webhook Notifuse → Hub
 * (lib/webhooks/notifuse-handlers.ts).
 *
 * Focus principal : `tenant.activity_threshold_reached` qui est l'entry
 * point de la trial state machine cross-app. On vérifie :
 *   - UPSERT correct avec state=eligible + eligible_at=NOW à la 1ère réception
 *   - Replay (même tenant_id) ne ré-écrit PAS state ni eligible_at
 *   - Format de payload conforme au contrat v1.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertMock = vi.fn();
const applySuspendedMock = vi.fn();
const applyResumedMock = vi.fn();
const applySoftDeletedMock = vi.fn();
const applyPurgedMock = vi.fn();
const applyOwnerChangedMock = vi.fn();
const applyQuotaExceededMock = vi.fn();
const applyMemberEventMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenantTrial: {
      upsert: (...args: unknown[]) => upsertMock(...args),
    },
  },
}));

vi.mock('@/lib/sync/snapshot-updater', () => ({
  applySuspended: (...args: unknown[]) => applySuspendedMock(...args),
  applyResumed: (...args: unknown[]) => applyResumedMock(...args),
  applySoftDeleted: (...args: unknown[]) => applySoftDeletedMock(...args),
  applyPurged: (...args: unknown[]) => applyPurgedMock(...args),
  applyOwnerChanged: (...args: unknown[]) => applyOwnerChangedMock(...args),
  applyQuotaExceeded: (...args: unknown[]) => applyQuotaExceededMock(...args),
  applyMemberEvent: (...args: unknown[]) => applyMemberEventMock(...args),
}));

beforeEach(() => {
  upsertMock.mockReset();
  applySuspendedMock.mockReset();
  applyResumedMock.mockReset();
  applySoftDeletedMock.mockReset();
  applyPurgedMock.mockReset();
  applyOwnerChangedMock.mockReset();
  applyQuotaExceededMock.mockReset();
  applyMemberEventMock.mockReset();
});

describe('v14Handlers.tenant.activity_threshold_reached', () => {
  it('upserts trial row with state=eligible + eligible_at=NOW on first signal', async () => {
    upsertMock.mockResolvedValue({});

    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    const handler = v14Handlers['tenant.activity_threshold_reached'];
    expect(handler).toBeDefined();

    await handler({
      event: 'tenant.activity_threshold_reached',
      tenant_id: 't_signal_1',
      data: {
        emails_sent_lifetime: 5,
        threshold: 5,
        reached_at: '2026-05-21T09:00:00.000Z',
      },
      idempotency_key: '00000000-0000-4000-8000-000000000001',
      occurred_at: '2026-05-21T09:00:01.000Z',
    });

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const arg = upsertMock.mock.calls[0][0];
    expect(arg.where).toEqual({
      tenantId_app: { tenantId: 't_signal_1', app: 'notifuse' },
    });
    expect(arg.create).toEqual(
      expect.objectContaining({
        tenantId: 't_signal_1',
        app: 'notifuse',
        state: 'eligible',
      }),
    );
    expect(arg.create.eligibleAt).toBeInstanceOf(Date);
    // L'update branch ne touche PAS state ni eligible_at (replay-safe)
    expect(arg.update).not.toHaveProperty('state');
    expect(arg.update).not.toHaveProperty('eligibleAt');
    expect(arg.update.updatedAt).toBeInstanceOf(Date);
  });

  it('relays the upsert (Prisma sémantique : create OR update update_at) on replay', async () => {
    // Prisma upsert s'occupe du "déjà existe" en interne — côté test on
    // vérifie surtout qu'on appelle bien upsert avec la même key et que
    // le branch UPDATE ne fait pas de régression sur state.
    upsertMock.mockResolvedValue({});

    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    const handler = v14Handlers['tenant.activity_threshold_reached'];

    await handler({
      event: 'tenant.activity_threshold_reached',
      tenant_id: 't_replay',
      data: {},
      idempotency_key: '00000000-0000-4000-8000-000000000002',
      occurred_at: '2026-05-21T09:00:00.000Z',
    });
    await handler({
      event: 'tenant.activity_threshold_reached',
      tenant_id: 't_replay',
      data: {},
      idempotency_key: '00000000-0000-4000-8000-000000000003',
      occurred_at: '2026-05-23T09:00:00.000Z',
    });

    expect(upsertMock).toHaveBeenCalledTimes(2);
    // Les 2 calls partagent la même PK
    expect(upsertMock.mock.calls[0][0].where).toEqual(
      upsertMock.mock.calls[1][0].where,
    );
    // Le 2nd appel n'écrase NI le state NI eligibleAt
    expect(upsertMock.mock.calls[1][0].update).not.toHaveProperty('state');
    expect(upsertMock.mock.calls[1][0].update).not.toHaveProperty('eligibleAt');
  });

  it('propagates upsert errors so the receiver leaves processed_at=NULL for retry', async () => {
    upsertMock.mockRejectedValueOnce(new Error('db connection lost'));

    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    const handler = v14Handlers['tenant.activity_threshold_reached'];

    await expect(
      handler({
        event: 'tenant.activity_threshold_reached',
        tenant_id: 't_err',
        data: {},
        idempotency_key: '00000000-0000-4000-8000-000000000004',
        occurred_at: '2026-05-21T09:00:00.000Z',
      }),
    ).rejects.toThrow(/db connection lost/);
  });
});

describe('v14Handlers table shape', () => {
  it('exposes the v1.4 contract events + Niveau 2 sync handlers', async () => {
    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    expect(Object.keys(v14Handlers).sort()).toEqual(
      [
        'tenant.activity_threshold_reached',
        'tenant.member_added',
        'tenant.member_removed',
        'tenant.member_role_changed',
        'tenant.owner_changed',
        'tenant.purged',
        'tenant.quota_exceeded',
        'tenant.resumed',
        'tenant.soft_deleted',
        'tenant.suspended',
        'tenant.touched',
      ].sort(),
    );
  });
});

// ============================================================================
// Niveau 2 du tenant sync — délégation aux helpers snapshot-updater.
// ============================================================================

describe('v14Handlers — Niveau 2 sync delegation (notifuse)', () => {
  it('tenant.suspended delegates to applySuspended with app=notifuse', async () => {
    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    await v14Handlers['tenant.suspended']({
      event: 'tenant.suspended',
      tenant_id: 'avse-slug',
      data: { suspended_at: '2026-05-23T10:00:00Z', reason: 'quota' },
      idempotency_key: '00000000-0000-4000-8000-000000000010',
      occurred_at: '2026-05-23T10:00:01Z',
    });
    expect(applySuspendedMock).toHaveBeenCalledWith(
      'notifuse',
      'avse-slug',
      { suspended_at: '2026-05-23T10:00:00Z', reason: 'quota' },
      '2026-05-23T10:00:01Z',
    );
  });

  it('tenant.resumed delegates to applyResumed', async () => {
    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    await v14Handlers['tenant.resumed']({
      event: 'tenant.resumed',
      tenant_id: 'avse-slug',
      data: { resumed_at: '2026-05-23T12:00:00Z' },
      idempotency_key: '00000000-0000-4000-8000-000000000011',
      occurred_at: '2026-05-23T12:00:01Z',
    });
    expect(applyResumedMock).toHaveBeenCalledWith(
      'notifuse',
      'avse-slug',
      { resumed_at: '2026-05-23T12:00:00Z' },
      '2026-05-23T12:00:01Z',
    );
  });

  it('tenant.soft_deleted delegates to applySoftDeleted', async () => {
    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    await v14Handlers['tenant.soft_deleted']({
      event: 'tenant.soft_deleted',
      tenant_id: 'avse-slug',
      data: { soft_deleted_at: '2026-05-23T13:00:00Z' },
      idempotency_key: '00000000-0000-4000-8000-000000000012',
      occurred_at: '2026-05-23T13:00:01Z',
    });
    expect(applySoftDeletedMock).toHaveBeenCalledTimes(1);
  });

  it('tenant.purged delegates to applyPurged', async () => {
    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    await v14Handlers['tenant.purged']({
      event: 'tenant.purged',
      tenant_id: 'avse-slug',
      data: { rows_deleted: 42 },
      idempotency_key: '00000000-0000-4000-8000-000000000013',
      occurred_at: '2026-05-23T14:00:01Z',
    });
    expect(applyPurgedMock).toHaveBeenCalledTimes(1);
  });

  it('tenant.owner_changed delegates to applyOwnerChanged', async () => {
    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    await v14Handlers['tenant.owner_changed']({
      event: 'tenant.owner_changed',
      tenant_id: 'avse-slug',
      data: { old_owner_email: 'a@x.com', new_owner_email: 'b@x.com' },
      idempotency_key: '00000000-0000-4000-8000-000000000014',
      occurred_at: '2026-05-23T15:00:01Z',
    });
    expect(applyOwnerChangedMock).toHaveBeenCalledTimes(1);
  });

  it('tenant.quota_exceeded delegates to applyQuotaExceeded', async () => {
    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    await v14Handlers['tenant.quota_exceeded']({
      event: 'tenant.quota_exceeded',
      tenant_id: 'avse-slug',
      data: { quota_type: 'emails', current: 1100, limit: 1000 },
      idempotency_key: '00000000-0000-4000-8000-000000000015',
      occurred_at: '2026-05-23T16:00:01Z',
    });
    expect(applyQuotaExceededMock).toHaveBeenCalledTimes(1);
  });

  it('tenant.member_added and tenant.member_removed delegate to applyMemberEvent with right kind', async () => {
    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    await v14Handlers['tenant.member_added']({
      event: 'tenant.member_added',
      tenant_id: 'avse-slug',
      data: { user_email: 'm@x.com', role: 'member' },
      idempotency_key: '00000000-0000-4000-8000-000000000016',
      occurred_at: '2026-05-23T17:00:01Z',
    });
    expect(applyMemberEventMock).toHaveBeenLastCalledWith(
      'notifuse',
      'avse-slug',
      'added',
      { user_email: 'm@x.com', role: 'member' },
      '2026-05-23T17:00:01Z',
    );

    await v14Handlers['tenant.member_removed']({
      event: 'tenant.member_removed',
      tenant_id: 'avse-slug',
      data: { user_email: 'm@x.com', reason: 'left' },
      idempotency_key: '00000000-0000-4000-8000-000000000017',
      occurred_at: '2026-05-23T17:10:01Z',
    });
    expect(applyMemberEventMock).toHaveBeenLastCalledWith(
      'notifuse',
      'avse-slug',
      'removed',
      { user_email: 'm@x.com', reason: 'left' },
      '2026-05-23T17:10:01Z',
    );
  });
});
