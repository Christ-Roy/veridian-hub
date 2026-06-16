/**
 * Tests de l'ingestion d'events comportementaux (lib/prospect/ingest.ts).
 *
 * L'INSERT event et le mouvement du score vivent dans une MÊME
 * `prisma.$transaction` (fix 2026-06-17 atomicité event↔score). Le mouvement
 * du score est fait en SQL atomique (`$executeRaw` : INSERT ... ON CONFLICT
 * DO UPDATE avec `engagement_score + points` et un `jsonb_set` incrémental).
 *
 * Le mock de `$transaction(cb)` EXÉCUTE réellement le callback avec un `tx`
 * mocké (`tx.prospectEvent.create` + `tx.$executeRaw`). Une erreur levée dans
 * le callback remonte hors de `$transaction` — exactement comme une vraie tx
 * qui rollback. C'est ce qui permet de tester l'atomicité :
 *   - INSERT event + mouvement de score dans la même unité (même `tx`)
 *   - replay (P2002 sur idempotency_key) → no-op, score NON déplacé, tx abort
 *   - échec du score APRÈS le create → l'erreur remonte (rollback), l'event
 *     n'est PAS persisté seul → le caller retry les DEUX
 *   - event sans contact_email → ingéré mais NON scoré (pas de $executeRaw)
 *   - event inconnu → ingéré mais NON scoré (points=0)
 *   - tenant résolu → tenant_uuid propagé ; résolution échouée → NULL, ingéré
 *   - normalisation email (lowercase/trim), occurred_at invalide → NOW
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks niveau `tx` (le callback de $transaction s'exécute dessus).
const txCreateMock = vi.fn();
const txExecuteRawMock = vi.fn();
// Mock de $transaction : exécute réellement le callback avec le tx mocké.
const transactionMock = vi.fn(
  async (cb: (tx: unknown) => unknown) =>
    cb({
      prospectEvent: { create: (...a: unknown[]) => txCreateMock(...a) },
      $executeRaw: (...a: unknown[]) => txExecuteRawMock(...a),
    }),
);
// Mocks top-level qui NE doivent PAS être appelés (tout passe par la tx).
const topLevelCreateMock = vi.fn();
const topLevelUpsertMock = vi.fn();
const resolveTenantMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (...a: unknown[]) =>
      (transactionMock as (...x: unknown[]) => unknown)(...a),
    prospectEvent: {
      create: (...a: unknown[]) => topLevelCreateMock(...a),
    },
    prospectScore: {
      upsert: (...a: unknown[]) => topLevelUpsertMock(...a),
    },
  },
}));

vi.mock('@/lib/sync/snapshot-updater', () => ({
  resolveTenantByExternalId: (...a: unknown[]) => resolveTenantMock(...a),
}));

import { ingestProspectEvent } from '@/lib/prospect/ingest';

beforeEach(() => {
  txCreateMock.mockReset();
  txExecuteRawMock.mockReset();
  transactionMock.mockClear();
  topLevelCreateMock.mockReset();
  topLevelUpsertMock.mockReset();
  resolveTenantMock.mockReset();
  // défauts : event neuf (create OK), score appliqué (executeRaw OK), tenant non résolu
  txCreateMock.mockResolvedValue({});
  txExecuteRawMock.mockResolvedValue(1);
  resolveTenantMock.mockResolvedValue(null);
});

const base = {
  app: 'notifuse' as const,
  workspaceSlug: 'ws_acme',
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
  occurredAt: '2026-06-15T10:00:00.000Z',
  contactEmail: 'prospect@acme.com',
};

/** Reconstitue la chaîne SQL d'un appel $executeRaw (Prisma.sql template). */
function sqlOf(call: unknown[]): string {
  const arg = call[0] as { strings?: string[]; sql?: string } | string;
  if (typeof arg === 'string') return arg;
  if (arg?.strings) return arg.strings.join('?');
  if (typeof arg?.sql === 'string') return arg.sql;
  return JSON.stringify(arg);
}

/** Valeurs interpolées d'un appel $executeRaw (Prisma.sql → .values). */
function valuesOf(call: unknown[]): unknown[] {
  const arg = call[0] as { values?: unknown[] };
  return arg?.values ?? [];
}

describe('ingestProspectEvent — atomicité event↔score (transaction)', () => {
  it('wraps create event + score move in a SINGLE $transaction', async () => {
    const res = await ingestProspectEvent({
      ...base,
      eventType: 'email.clicked',
      data: { link_url: 'https://x' },
    });

    expect(res).toEqual({ ingested: true, scored: true, points: 5 });
    // Tout passe par la transaction, jamais le client top-level.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(topLevelCreateMock).not.toHaveBeenCalled();
    expect(topLevelUpsertMock).not.toHaveBeenCalled();
    // create event ET mouvement de score se font sur le MÊME tx.
    expect(txCreateMock).toHaveBeenCalledTimes(1);
    expect(txExecuteRawMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT commit the event alone when the score move fails (rollback → caller retries)', async () => {
    // L'event s'insère, puis le mouvement du score plante (perte connexion DB).
    txCreateMock.mockResolvedValueOnce({});
    txExecuteRawMock.mockRejectedValueOnce(
      Object.assign(new Error('connection lost'), { code: 'P1001' }),
    );

    // L'erreur DOIT remonter (la tx rollback) — pas de { ingested:true } silencieux.
    await expect(
      ingestProspectEvent({ ...base, eventType: 'email.replied' }),
    ).rejects.toThrow(/connection lost/);

    // Sabotage-test : sans la transaction, le create serait committé seul et
    // l'erreur du score remonterait quand même → le retry serait avalé en P2002
    // → score perdu. Ici create + score sont dans la MÊME tx (le mock exécute
    // les deux via le même `tx`), donc l'échec rollback les deux.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(txCreateMock).toHaveBeenCalledTimes(1);
    expect(txExecuteRawMock).toHaveBeenCalledTimes(1);
  });

  it('passes the right points + signal key + keys to the atomic score SQL', async () => {
    await ingestProspectEvent({ ...base, eventType: 'email.clicked' });

    const call = txExecuteRawMock.mock.calls[0];
    const sql = sqlOf(call);
    const values = valuesOf(call);
    // SQL atomique : ON CONFLICT DO UPDATE avec increment + jsonb_set.
    expect(sql).toMatch(/INSERT INTO hub_app\.prospect_scores/i);
    expect(sql).toMatch(/ON CONFLICT \(workspace_slug, contact_email\) DO UPDATE/i);
    expect(sql).toMatch(/engagement_score = hub_app\.prospect_scores\.engagement_score \+/i);
    expect(sql).toMatch(/jsonb_set/i);
    // Les valeurs interpolées contiennent les bons params (points=5, clé=clicked).
    expect(values).toContain('ws_acme');
    expect(values).toContain('prospect@acme.com');
    expect(values).toContain(5); // points clicked
    expect(values).toContain('clicked'); // clé de signal
  });

  it('applies replied=+20 with the replied signal key', async () => {
    const res = await ingestProspectEvent({ ...base, eventType: 'email.replied' });
    expect(res.points).toBe(20);
    const values = valuesOf(txExecuteRawMock.mock.calls[0]);
    expect(values).toContain(20);
    expect(values).toContain('replied');
  });
});

describe('ingestProspectEvent — idempotence (replay)', () => {
  it('returns ingested:false and does NOT move the score on P2002 unique violation', async () => {
    txCreateMock.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    const res = await ingestProspectEvent({ ...base, eventType: 'email.clicked' });
    expect(res).toEqual({ ingested: false, scored: false, points: 0 });
    // La tx a été ouverte mais le score n'a PAS bougé (replay = no-op, anti double comptage).
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(txExecuteRawMock).not.toHaveBeenCalled();
  });

  it('re-throws non-P2002 errors on the create so the caller can retry', async () => {
    txCreateMock.mockRejectedValueOnce(
      Object.assign(new Error('connection lost'), { code: 'P1001' }),
    );
    await expect(
      ingestProspectEvent({ ...base, eventType: 'email.clicked' }),
    ).rejects.toThrow(/connection lost/);
    expect(txExecuteRawMock).not.toHaveBeenCalled();
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
    expect(txCreateMock).toHaveBeenCalledTimes(1);
    expect(txCreateMock.mock.calls[0][0].data.contactEmail).toBeNull();
    // pas de mouvement de score (event non joint à un prospect).
    expect(txExecuteRawMock).not.toHaveBeenCalled();
  });

  it('ingests but does not score an unknown event type', async () => {
    const res = await ingestProspectEvent({
      ...base,
      eventType: 'email.bounced',
    });
    expect(res).toEqual({ ingested: true, scored: false, points: 0 });
    expect(txCreateMock).toHaveBeenCalledTimes(1);
    expect(txExecuteRawMock).not.toHaveBeenCalled();
  });
});

describe('ingestProspectEvent — tenant resolution', () => {
  it('propagates resolved tenant uuid onto event + score', async () => {
    resolveTenantMock.mockResolvedValueOnce({
      id: '11111111-1111-1111-1111-111111111111',
      metadata: {},
    });
    await ingestProspectEvent({ ...base, eventType: 'email.opened' });
    expect(txCreateMock.mock.calls[0][0].data.tenantUuid).toBe(
      '11111111-1111-1111-1111-111111111111',
    );
    // tenant_uuid interpolé dans le SQL atomique du score.
    expect(valuesOf(txExecuteRawMock.mock.calls[0])).toContain(
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
  it('normalizes email to lowercase/trim (on event + score SQL)', async () => {
    await ingestProspectEvent({
      ...base,
      contactEmail: '  Prospect@ACME.com  ',
      eventType: 'email.opened',
    });
    expect(txCreateMock.mock.calls[0][0].data.contactEmail).toBe('prospect@acme.com');
    expect(valuesOf(txExecuteRawMock.mock.calls[0])).toContain('prospect@acme.com');
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
    expect(valuesOf(txExecuteRawMock.mock.calls[0])).toContain('vid_abc123');
  });
});
