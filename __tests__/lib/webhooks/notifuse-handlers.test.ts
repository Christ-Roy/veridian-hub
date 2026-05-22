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

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenantTrial: {
      upsert: (...args: unknown[]) => upsertMock(...args),
    },
  },
}));

beforeEach(() => {
  upsertMock.mockReset();
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
  it('exposes the 3 contract events as stubs/handlers', async () => {
    const { v14Handlers } = await import('@/lib/webhooks/notifuse-handlers');
    expect(Object.keys(v14Handlers).sort()).toEqual(
      [
        'tenant.activity_threshold_reached',
        'tenant.member_role_changed',
        'tenant.touched',
      ].sort(),
    );
  });
});
