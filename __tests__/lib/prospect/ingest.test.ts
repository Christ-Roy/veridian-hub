/**
 * Tests de l'ingestion d'events comportementaux (lib/prospect/ingest.ts).
 *
 * EVENTS ⟂ SCORING — DÉCOUPLÉS (archi Robert 2026-06-17). L'ingestion PERSISTE
 * l'event, POINT. Elle ne calcule AUCUN score (le scoring est une couche
 * séparée, appelée à la demande par un job/cron). Ces tests VERROUILLENT ce
 * découplage : l'ingestion ne doit JAMAIS toucher prospect_scores ni appeler la
 * couche scoring.
 *
 * Le mock de `$transaction(cb)` EXÉCUTE réellement le callback avec un `tx`
 * mocké (`tx.prospectEvent.create`). Une erreur levée dans le callback remonte
 * hors de `$transaction` — comme une vraie tx qui rollback. Ce qu'on teste :
 *   - INSERT event dans la transaction (et JAMAIS via le client top-level)
 *   - AUCUN scoring : pas de $queryRaw / $executeRaw, score non touché
 *   - replay (P2002 sur idempotency_key) → no-op gracieux { ingested:false }
 *   - autre erreur sur le create → remonte (rollback) pour retry caller
 *   - event sans contact_email / type inconnu → ingéré quand même (forensics)
 *   - tenant résolu → tenant_uuid propagé ; résolution échouée → NULL, ingéré
 *   - normalisation email (lowercase/trim), occurred_at invalide → NOW
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const txCreateMock = vi.fn();
// Ces deux-là NE doivent JAMAIS être appelés (le scoring est découplé de l'ingestion).
const txQueryRawMock = vi.fn();
const txExecuteRawMock = vi.fn();
const transactionMock = vi.fn(
  async (cb: (tx: unknown) => unknown) =>
    cb({
      prospectEvent: { create: (...a: unknown[]) => txCreateMock(...a) },
      $queryRaw: (...a: unknown[]) => txQueryRawMock(...a),
      $executeRaw: (...a: unknown[]) => txExecuteRawMock(...a),
    }),
);
// Mocks top-level qui NE doivent PAS être appelés (tout passe par la tx).
const topLevelCreateMock = vi.fn();
const resolveTenantMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (...a: unknown[]) =>
      (transactionMock as (...x: unknown[]) => unknown)(...a),
    prospectEvent: {
      create: (...a: unknown[]) => topLevelCreateMock(...a),
    },
  },
}));

vi.mock('@/lib/sync/snapshot-updater', () => ({
  resolveTenantByExternalId: (...a: unknown[]) => resolveTenantMock(...a),
}));

import { ingestProspectEvent } from '@/lib/prospect/ingest';

beforeEach(() => {
  txCreateMock.mockReset();
  txQueryRawMock.mockReset();
  txExecuteRawMock.mockReset();
  transactionMock.mockClear();
  topLevelCreateMock.mockReset();
  resolveTenantMock.mockReset();
  // défauts : event neuf (create OK), tenant non résolu.
  txCreateMock.mockResolvedValue({});
  resolveTenantMock.mockResolvedValue(null);
});

const base = {
  app: 'notifuse' as const,
  workspaceSlug: 'ws_acme',
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
  occurredAt: '2026-06-15T10:00:00.000Z',
  contactEmail: 'prospect@acme.com',
};

describe("ingestProspectEvent — persiste l'event SEUL (découplé du scoring)", () => {
  it('inserts the event inside a $transaction, never via the top-level client', async () => {
    const res = await ingestProspectEvent({
      ...base,
      eventType: 'email.clicked',
      data: { link_url: 'https://x' },
    });
    expect(res).toEqual({ ingested: true });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(txCreateMock).toHaveBeenCalledTimes(1);
    expect(topLevelCreateMock).not.toHaveBeenCalled();
  });

  it('NEVER scores at ingestion (no $queryRaw / $executeRaw on prospect_scores)', async () => {
    // Garde-fou du découplage : un event scorable NE déclenche AUCUN calcul de
    // score à l'ingestion. Le score est recalculé plus tard, ailleurs.
    await ingestProspectEvent({ ...base, eventType: 'email.replied' });
    expect(txQueryRawMock).not.toHaveBeenCalled();
    expect(txExecuteRawMock).not.toHaveBeenCalled();
  });

  it('persists all event fields (type, email, ws, idempotencyKey, data)', async () => {
    await ingestProspectEvent({
      ...base,
      eventType: 'email.clicked',
      data: { link_url: 'https://x' },
    });
    const created = txCreateMock.mock.calls[0][0].data;
    expect(created.eventType).toBe('email.clicked');
    expect(created.contactEmail).toBe('prospect@acme.com');
    expect(created.workspaceSlug).toBe('ws_acme');
    expect(created.idempotencyKey).toBe(base.idempotencyKey);
    expect(created.data).toEqual({ link_url: 'https://x' });
  });

  it('ingests an event WITHOUT contact_email (page.hit anonyme, forensics)', async () => {
    const res = await ingestProspectEvent({
      ...base,
      contactEmail: null,
      eventType: 'page.hit',
      data: { page_path: '/audit' },
    });
    expect(res).toEqual({ ingested: true });
    expect(txCreateMock.mock.calls[0][0].data.contactEmail).toBeNull();
  });

  it("ingests an unknown event type (forensics — l'ingestion ne filtre rien)", async () => {
    const res = await ingestProspectEvent({ ...base, eventType: 'tenant.suspended' });
    expect(res).toEqual({ ingested: true });
    expect(txCreateMock).toHaveBeenCalledTimes(1);
  });
});

describe('ingestProspectEvent — idempotence (replay)', () => {
  it('returns ingested:false on P2002 unique violation (no-op gracieux)', async () => {
    txCreateMock.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    const res = await ingestProspectEvent({ ...base, eventType: 'email.clicked' });
    expect(res).toEqual({ ingested: false });
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('re-throws non-P2002 errors on the create so the caller can retry', async () => {
    txCreateMock.mockRejectedValueOnce(
      Object.assign(new Error('connection lost'), { code: 'P1001' }),
    );
    await expect(
      ingestProspectEvent({ ...base, eventType: 'email.clicked' }),
    ).rejects.toThrow(/connection lost/);
  });
});

describe('ingestProspectEvent — tenant resolution (best-effort)', () => {
  it('propagates resolved tenant uuid onto the event', async () => {
    resolveTenantMock.mockResolvedValueOnce({
      id: '11111111-1111-1111-1111-111111111111',
      metadata: {},
    });
    await ingestProspectEvent({ ...base, eventType: 'email.opened' });
    expect(txCreateMock.mock.calls[0][0].data.tenantUuid).toBe(
      '11111111-1111-1111-1111-111111111111',
    );
  });

  it('ingests with tenantUuid=null when resolution returns null', async () => {
    resolveTenantMock.mockResolvedValueOnce(null);
    await ingestProspectEvent({ ...base, eventType: 'email.opened' });
    expect(txCreateMock.mock.calls[0][0].data.tenantUuid).toBeNull();
  });

  it('ingests with tenantUuid=null when resolution THROWS (best-effort)', async () => {
    resolveTenantMock.mockRejectedValueOnce(new Error('db down'));
    const res = await ingestProspectEvent({ ...base, eventType: 'email.opened' });
    expect(res.ingested).toBe(true);
    expect(txCreateMock.mock.calls[0][0].data.tenantUuid).toBeNull();
  });
});

describe('ingestProspectEvent — normalization + occurred_at', () => {
  it('normalizes email to lowercase/trim on the event', async () => {
    await ingestProspectEvent({
      ...base,
      contactEmail: '  Prospect@ACME.com  ',
      eventType: 'email.opened',
    });
    expect(txCreateMock.mock.calls[0][0].data.contactEmail).toBe('prospect@acme.com');
  });

  it('falls back to NOW for an invalid occurred_at (never Invalid Date in DB)', async () => {
    await ingestProspectEvent({
      ...base,
      occurredAt: 'not-a-date',
      eventType: 'email.opened',
    });
    const occurredAt = txCreateMock.mock.calls[0][0].data.occurredAt;
    expect(occurredAt).toBeInstanceOf(Date);
    expect(Number.isNaN(occurredAt.getTime())).toBe(false);
  });

  it('stores vid when provided (étage 2 forward-compat)', async () => {
    await ingestProspectEvent({
      ...base,
      vid: 'vid_abc123',
      eventType: 'email.clicked',
    });
    expect(txCreateMock.mock.calls[0][0].data.vid).toBe('vid_abc123');
  });

  it('stores vid=null when empty/absent', async () => {
    await ingestProspectEvent({ ...base, vid: '', eventType: 'email.clicked' });
    expect(txCreateMock.mock.calls[0][0].data.vid).toBeNull();
  });
});
