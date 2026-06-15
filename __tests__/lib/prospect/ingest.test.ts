/**
 * Tests de l'ingestion d'events comportementaux (lib/prospect/ingest.ts).
 *
 * On mocke prisma (prospectEvent.create / prospectScore.findUnique+upsert) et
 * le resolver tenant. On vérifie le COMPORTEMENT :
 *   - INSERT event + UPSERT score avec les bons points (barème)
 *   - replay (P2002 sur idempotency_key) → no-op, score NON ré-incrémenté
 *   - event sans contact_email → ingéré mais NON scoré
 *   - event inconnu → ingéré mais NON scoré (points=0)
 *   - tenant résolu → tenant_uuid propagé ; résolution échouée → NULL, ingéré
 *   - lastEventAt = max(existant, occurredAt) (out-of-order safe)
 *   - normalisation email (lowercase/trim)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
const findUniqueMock = vi.fn();
const upsertMock = vi.fn();
const resolveTenantMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    prospectEvent: {
      create: (...a: unknown[]) => createMock(...a),
    },
    prospectScore: {
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
      upsert: (...a: unknown[]) => upsertMock(...a),
    },
  },
}));

vi.mock('@/lib/sync/snapshot-updater', () => ({
  resolveTenantByExternalId: (...a: unknown[]) => resolveTenantMock(...a),
}));

import { ingestProspectEvent } from '@/lib/prospect/ingest';

beforeEach(() => {
  createMock.mockReset();
  findUniqueMock.mockReset();
  upsertMock.mockReset();
  resolveTenantMock.mockReset();
  // défauts : event neuf, pas de score existant, tenant non résolu
  createMock.mockResolvedValue({});
  findUniqueMock.mockResolvedValue(null);
  upsertMock.mockResolvedValue({});
  resolveTenantMock.mockResolvedValue(null);
});

const base = {
  app: 'notifuse' as const,
  workspaceSlug: 'ws_acme',
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
  occurredAt: '2026-06-15T10:00:00.000Z',
  contactEmail: 'prospect@acme.com',
};

describe('ingestProspectEvent — happy path scoring', () => {
  it('inserts the event and upserts the score with clicked=+5', async () => {
    const res = await ingestProspectEvent({
      ...base,
      eventType: 'email.clicked',
      data: { link_url: 'https://x' },
    });

    expect(res).toEqual({ ingested: true, scored: true, points: 5 });

    expect(createMock).toHaveBeenCalledTimes(1);
    const created = createMock.mock.calls[0][0].data;
    expect(created).toMatchObject({
      app: 'notifuse',
      eventType: 'email.clicked',
      workspaceSlug: 'ws_acme',
      contactEmail: 'prospect@acme.com',
      idempotencyKey: base.idempotencyKey,
    });
    expect(created.occurredAt).toBeInstanceOf(Date);

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const up = upsertMock.mock.calls[0][0];
    expect(up.where).toEqual({
      workspaceSlug_contactEmail: {
        workspaceSlug: 'ws_acme',
        contactEmail: 'prospect@acme.com',
      },
    });
    expect(up.create.engagementScore).toBe(5);
    expect(up.create.signals).toEqual({ clicked: 1 });
    expect(up.update.engagementScore).toEqual({ increment: 5 });
    expect(up.update.signals).toEqual({ clicked: 1 });
  });

  it('applies replied=+20 and signals replied counter', async () => {
    const res = await ingestProspectEvent({ ...base, eventType: 'email.replied' });
    expect(res.points).toBe(20);
    expect(upsertMock.mock.calls[0][0].create.signals).toEqual({ replied: 1 });
  });

  it('accumulates onto existing signals when a score row already exists', async () => {
    findUniqueMock.mockResolvedValueOnce({
      signals: { opened: 3, clicked: 1 },
      lastEventAt: new Date('2026-06-15T09:00:00.000Z'),
    });
    await ingestProspectEvent({ ...base, eventType: 'email.opened' });
    const up = upsertMock.mock.calls[0][0];
    expect(up.update.signals).toEqual({ opened: 4, clicked: 1 });
    expect(up.update.engagementScore).toEqual({ increment: 1 });
  });
});

describe('ingestProspectEvent — idempotence (replay)', () => {
  it('returns ingested:false and does NOT score on P2002 unique violation', async () => {
    createMock.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    const res = await ingestProspectEvent({ ...base, eventType: 'email.clicked' });
    expect(res).toEqual({ ingested: false, scored: false, points: 0 });
    // pas de score touché
    expect(upsertMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('re-throws non-P2002 errors so the caller can retry', async () => {
    createMock.mockRejectedValueOnce(
      Object.assign(new Error('connection lost'), { code: 'P1001' }),
    );
    await expect(
      ingestProspectEvent({ ...base, eventType: 'email.clicked' }),
    ).rejects.toThrow(/connection lost/);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe('ingestProspectEvent — not-scored cases (still ingested)', () => {
  it('ingests but does not score an event without contact_email', async () => {
    const res = await ingestProspectEvent({
      ...base,
      contactEmail: null,
      eventType: 'page.hit',
      data: { page_path: '/audit' },
    });
    expect(res).toEqual({ ingested: true, scored: false, points: 0 });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data.contactEmail).toBeNull();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('ingests but does not score an unknown event type', async () => {
    const res = await ingestProspectEvent({
      ...base,
      eventType: 'email.bounced',
    });
    expect(res).toEqual({ ingested: true, scored: false, points: 0 });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe('ingestProspectEvent — tenant resolution', () => {
  it('propagates resolved tenant uuid onto event + score', async () => {
    resolveTenantMock.mockResolvedValueOnce({
      id: '11111111-1111-1111-1111-111111111111',
      metadata: {},
    });
    await ingestProspectEvent({ ...base, eventType: 'email.opened' });
    expect(createMock.mock.calls[0][0].data.tenantUuid).toBe(
      '11111111-1111-1111-1111-111111111111',
    );
    expect(upsertMock.mock.calls[0][0].create.tenantUuid).toBe(
      '11111111-1111-1111-1111-111111111111',
    );
  });

  it('ingests with tenantUuid=null when resolution returns null', async () => {
    resolveTenantMock.mockResolvedValueOnce(null);
    await ingestProspectEvent({ ...base, eventType: 'email.opened' });
    expect(createMock.mock.calls[0][0].data.tenantUuid).toBeNull();
  });

  it('ingests with tenantUuid=null when resolution THROWS (best-effort)', async () => {
    resolveTenantMock.mockRejectedValueOnce(new Error('db down'));
    const res = await ingestProspectEvent({ ...base, eventType: 'email.opened' });
    expect(res.ingested).toBe(true);
    expect(createMock.mock.calls[0][0].data.tenantUuid).toBeNull();
  });
});

describe('ingestProspectEvent — normalization + ordering', () => {
  it('normalizes email to lowercase/trim', async () => {
    await ingestProspectEvent({
      ...base,
      contactEmail: '  Prospect@ACME.com  ',
      eventType: 'email.opened',
    });
    expect(createMock.mock.calls[0][0].data.contactEmail).toBe('prospect@acme.com');
    expect(upsertMock.mock.calls[0][0].where).toEqual({
      workspaceSlug_contactEmail: {
        workspaceSlug: 'ws_acme',
        contactEmail: 'prospect@acme.com',
      },
    });
  });

  it('keeps the most recent lastEventAt on out-of-order events', async () => {
    findUniqueMock.mockResolvedValueOnce({
      signals: {},
      lastEventAt: new Date('2026-06-15T12:00:00.000Z'), // plus récent que l'event
    });
    await ingestProspectEvent({
      ...base,
      occurredAt: '2026-06-15T10:00:00.000Z', // event plus ancien
      eventType: 'email.opened',
    });
    expect(upsertMock.mock.calls[0][0].update.lastEventAt).toEqual(
      new Date('2026-06-15T12:00:00.000Z'),
    );
  });

  it('falls back to NOW for an invalid occurred_at (never Invalid Date in DB)', async () => {
    await ingestProspectEvent({
      ...base,
      occurredAt: 'not-a-date',
      eventType: 'email.opened',
    });
    const occurredAt = createMock.mock.calls[0][0].data.occurredAt;
    expect(occurredAt).toBeInstanceOf(Date);
    expect(Number.isNaN(occurredAt.getTime())).toBe(false);
  });

  it('stores vid when provided (étage 2 forward-compat)', async () => {
    await ingestProspectEvent({
      ...base,
      vid: 'vid_abc123',
      eventType: 'email.clicked',
    });
    expect(createMock.mock.calls[0][0].data.vid).toBe('vid_abc123');
    expect(upsertMock.mock.calls[0][0].create.vid).toBe('vid_abc123');
    expect(upsertMock.mock.calls[0][0].update.vid).toBe('vid_abc123');
  });
});
