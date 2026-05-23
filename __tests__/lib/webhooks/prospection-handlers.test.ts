/**
 * Tests des handlers v1.4 du webhook Prospection → Hub (Niveau 2 du
 * tenant sync). On vérifie la délégation vers les helpers
 * `lib/sync/snapshot-updater.ts` avec app=prospection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const applySuspendedMock = vi.fn();
const applyResumedMock = vi.fn();
const applySoftDeletedMock = vi.fn();
const applyPurgedMock = vi.fn();
const applyOwnerChangedMock = vi.fn();
const applyQuotaExceededMock = vi.fn();
const applyMemberEventMock = vi.fn();

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
  applySuspendedMock.mockReset();
  applyResumedMock.mockReset();
  applySoftDeletedMock.mockReset();
  applyPurgedMock.mockReset();
  applyOwnerChangedMock.mockReset();
  applyQuotaExceededMock.mockReset();
  applyMemberEventMock.mockReset();
});

describe('prospectionHandlers — handler table shape', () => {
  it('exposes the contract v1.4 events + Niveau 2 sync handlers', async () => {
    const { prospectionHandlers } = await import(
      '@/lib/webhooks/prospection-handlers'
    );
    expect(Object.keys(prospectionHandlers).sort()).toEqual(
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

describe('prospectionHandlers — Niveau 2 delegation (app=prospection)', () => {
  it('tenant.suspended → applySuspended(prospection)', async () => {
    const { prospectionHandlers } = await import(
      '@/lib/webhooks/prospection-handlers'
    );
    await prospectionHandlers['tenant.suspended']({
      event: 'tenant.suspended',
      tenant_id: 't-uuid',
      data: { reason: 'admin' },
      idempotency_key: '00000000-0000-4000-8000-000000000020',
      occurred_at: '2026-05-23T10:00:00Z',
    });
    expect(applySuspendedMock).toHaveBeenCalledWith(
      'prospection',
      't-uuid',
      { reason: 'admin' },
      '2026-05-23T10:00:00Z',
    );
  });

  it('tenant.resumed → applyResumed(prospection)', async () => {
    const { prospectionHandlers } = await import(
      '@/lib/webhooks/prospection-handlers'
    );
    await prospectionHandlers['tenant.resumed']({
      event: 'tenant.resumed',
      tenant_id: 't-uuid',
      data: { resumed_at: '2026-05-23T12:00:00Z' },
      idempotency_key: '00000000-0000-4000-8000-000000000021',
      occurred_at: '2026-05-23T12:00:00Z',
    });
    expect(applyResumedMock).toHaveBeenCalledTimes(1);
    expect(applyResumedMock.mock.calls[0][0]).toBe('prospection');
  });

  it('tenant.member_added → applyMemberEvent(prospection, added)', async () => {
    const { prospectionHandlers } = await import(
      '@/lib/webhooks/prospection-handlers'
    );
    await prospectionHandlers['tenant.member_added']({
      event: 'tenant.member_added',
      tenant_id: 't-uuid',
      data: { user_email: 'x@y.com', role: 'member' },
      idempotency_key: '00000000-0000-4000-8000-000000000022',
      occurred_at: '2026-05-23T17:00:00Z',
    });
    expect(applyMemberEventMock).toHaveBeenCalledWith(
      'prospection',
      't-uuid',
      'added',
      { user_email: 'x@y.com', role: 'member' },
      '2026-05-23T17:00:00Z',
    );
  });
});
