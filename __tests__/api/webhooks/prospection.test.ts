/**
 * Tests colocaux de la route POST /api/webhooks/prospection.
 *
 * Pattern : mocke @/lib/prisma (table webhookDedup), garde la vraie
 * lib/webhooks/receiver — ainsi le test exerce vraiment l'intégration
 * route + receiver (Bearer auth, dédup, dispatch, marquage processed_at).
 *
 * Référence : contrat v1.4 §7.1 + docs/CONTRAT-HUB-API-REF.md
 *  (section "Webhooks app → Hub").
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TOKEN = 'p'.repeat(64);

interface DedupRow {
  app: string;
  idempotencyKey: string;
  eventType: string;
  payload: any;
  receivedAt: Date;
  processedAt: Date | null;
}

const rows: DedupRow[] = [];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    webhookDedup: {
      create: vi.fn(async ({ data }: any) => {
        const exists = rows.find(
          (r) => r.app === data.app && r.idempotencyKey === data.idempotencyKey,
        );
        if (exists) {
          const err: any = new Error('Unique constraint violation');
          err.code = 'P2002';
          throw err;
        }
        const row: DedupRow = {
          app: data.app,
          idempotencyKey: data.idempotencyKey,
          eventType: data.eventType,
          payload: data.payload,
          receivedAt: new Date(),
          processedAt: null,
        };
        rows.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const k = where.app_idempotencyKey;
        return (
          rows.find(
            (r) => r.app === k.app && r.idempotencyKey === k.idempotencyKey,
          ) ?? null
        );
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const k = where.app_idempotencyKey;
        const row = rows.find(
          (r) => r.app === k.app && r.idempotencyKey === k.idempotencyKey,
        );
        if (!row) throw new Error('not found');
        if (data.processedAt !== undefined) row.processedAt = data.processedAt;
        return row;
      }),
    },
  },
}));

// Niveau 2 du tenant sync : les nouveaux handlers `tenant.suspended/resumed/...`
// délèguent vers ces helpers. On les mocke en no-op observable pour isoler la
// route handler du contrat Prisma → ce sont les tests
// `__tests__/lib/sync/snapshot-updater.test.ts` qui couvrent la vraie logique.
const syncMocks = {
  applySuspended: vi.fn(async () => undefined),
  applyResumed: vi.fn(async () => undefined),
  applySoftDeleted: vi.fn(async () => undefined),
  applyPurged: vi.fn(async () => undefined),
  applyOwnerChanged: vi.fn(async () => undefined),
  applyQuotaExceeded: vi.fn(async () => undefined),
  applyMemberEvent: vi.fn(async () => undefined),
};
vi.mock('@/lib/sync/snapshot-updater', () => syncMocks);

const ORIGINAL_TOKEN = process.env.PROSPECTION_WEBHOOK_TOKEN;

beforeEach(() => {
  rows.length = 0;
  vi.clearAllMocks();
  process.env.PROSPECTION_WEBHOOK_TOKEN = TOKEN;
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.PROSPECTION_WEBHOOK_TOKEN;
  } else {
    process.env.PROSPECTION_WEBHOOK_TOKEN = ORIGINAL_TOKEN;
  }
});

function uuid(seed: string): string {
  const hex = Array.from(seed)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(32, '0')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function makeReq(opts: {
  authHeader?: string | null;
  body: string | object;
}): Request {
  const headers = new Headers();
  if (opts.authHeader !== null && opts.authHeader !== undefined) {
    headers.set('authorization', opts.authHeader);
  }
  const body =
    typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  return new Request('https://hub.veridian.site/api/webhooks/prospection', {
    method: 'POST',
    headers,
    body,
  });
}

function validPayload(seed: string, event = 'tenant.touched') {
  return {
    event,
    tenant_id: 't_prospection_1',
    data: { reason: 'user_active_on_soft_deleted' },
    idempotency_key: uuid(seed),
    occurred_at: new Date().toISOString(),
    contract_version: '1.4',
  };
}

describe('POST /api/webhooks/prospection — config guard', () => {
  it('returns 500 internal_error when PROSPECTION_WEBHOOK_TOKEN is not set', async () => {
    delete process.env.PROSPECTION_WEBHOOK_TOKEN;
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const req = makeReq({
      authHeader: `Bearer ${TOKEN}`,
      body: validPayload('no-token'),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('internal_error');
    expect(json.message).toContain('PROSPECTION_WEBHOOK_TOKEN');
    expect(rows).toHaveLength(0);
  });

  it('returns 500 even with valid Bearer when token env is empty string', async () => {
    process.env.PROSPECTION_WEBHOOK_TOKEN = '';
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const req = makeReq({
      authHeader: `Bearer ${TOKEN}`,
      body: validPayload('empty-token'),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(500);
    expect(rows).toHaveLength(0);
  });
});

describe('POST /api/webhooks/prospection — auth', () => {
  it('returns 401 when Authorization header missing', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const req = makeReq({
      authHeader: null,
      body: validPayload('no-auth'),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('unauthorized');
    expect(rows).toHaveLength(0);
  });

  it('returns 401 on malformed Bearer header', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const req = makeReq({
      authHeader: 'Token whatever',
      body: validPayload('bad-fmt'),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(401);
    expect(rows).toHaveLength(0);
  });

  it('returns 401 on wrong token (same length)', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const wrong = 'q'.repeat(64);
    const req = makeReq({
      authHeader: `Bearer ${wrong}`,
      body: validPayload('wrong-same-len'),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('unauthorized');
    expect(rows).toHaveLength(0);
  });

  it('returns 401 on wrong token (different length)', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const req = makeReq({
      authHeader: 'Bearer short',
      body: validPayload('wrong-diff-len'),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(401);
    expect(rows).toHaveLength(0);
  });
});

describe('POST /api/webhooks/prospection — dispatch happy paths', () => {
  it('dispatches tenant.touched, persists row + processedAt', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const body = validPayload('touched');
    const req = makeReq({
      authHeader: `Bearer ${TOKEN}`,
      body,
    });
    const res = await POST(req as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, accepted: true, dispatched: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].app).toBe('prospection');
    expect(rows[0].eventType).toBe('tenant.touched');
    expect(rows[0].idempotencyKey).toBe(body.idempotency_key);
    expect(rows[0].processedAt).toBeInstanceOf(Date);
  });

  it('dispatches tenant.member_role_changed', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const body = validPayload('role-changed', 'tenant.member_role_changed');
    const req = makeReq({
      authHeader: `Bearer ${TOKEN}`,
      body,
    });
    const res = await POST(req as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.dispatched).toBe(true);
    expect(rows[0].eventType).toBe('tenant.member_role_changed');
    expect(rows[0].processedAt).toBeInstanceOf(Date);
  });

  it('dispatches tenant.activity_threshold_reached', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const body = validPayload('threshold', 'tenant.activity_threshold_reached');
    const req = makeReq({
      authHeader: `Bearer ${TOKEN}`,
      body,
    });
    const res = await POST(req as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.dispatched).toBe(true);
    expect(rows[0].eventType).toBe('tenant.activity_threshold_reached');
    expect(rows[0].processedAt).toBeInstanceOf(Date);
  });
});

describe('POST /api/webhooks/prospection — dedup & unknown events', () => {
  it('replays same idempotency_key → 200 deduplicated, no double dispatch', async () => {
    const { POST: POST1 } = await import('@/app/api/webhooks/prospection/route');
    const body = validPayload('replay');
    const make = () =>
      makeReq({ authHeader: `Bearer ${TOKEN}`, body });

    const r1 = await POST1(make() as any);
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1).toEqual({ ok: true, accepted: true, dispatched: true });

    const r2 = await POST1(make() as any);
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2).toMatchObject({
      ok: true,
      deduplicated: true,
      processed: true,
    });
    expect(rows).toHaveLength(1);
  });

  it('unknown event type → 200 dispatched=false, row still persisted + marked processed', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const body = validPayload('unknown', 'tenant.some_future_event');
    const req = makeReq({
      authHeader: `Bearer ${TOKEN}`,
      body,
    });
    const res = await POST(req as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, accepted: true, dispatched: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].app).toBe('prospection');
    expect(rows[0].eventType).toBe('tenant.some_future_event');
    expect(rows[0].processedAt).toBeInstanceOf(Date);
  });
});

describe('POST /api/webhooks/prospection — occurred_at field (contrat §5.18.4)', () => {
  it('accepts a payload with occurred_at → 200 (Prospection conforme au contrat)', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const body = validPayload('occurred-ok', 'tenant.member_role_changed');
    // Garde-fou anti-régression : le contrat dit `occurred_at`, pas `emitted_at`.
    expect(body).toHaveProperty('occurred_at');
    expect(body).not.toHaveProperty('emitted_at');
    const res = await POST(
      makeReq({ authHeader: `Bearer ${TOKEN}`, body }) as any,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, accepted: true, dispatched: true });
    expect(rows).toHaveLength(1);
  });

  it('rejects the legacy field name emitted_at → 400 missing occurred_at', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const res = await POST(
      makeReq({
        authHeader: `Bearer ${TOKEN}`,
        body: {
          event: 'tenant.member_role_changed',
          tenant_id: 't_prospection_1',
          data: {},
          idempotency_key: uuid('legacy-field'),
          emitted_at: new Date().toISOString(),
        },
      }) as any,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_payload');
    expect(json.details.fields).toContain('occurred_at');
    expect(rows).toHaveLength(0);
  });
});

describe('POST /api/webhooks/prospection — payload validation', () => {
  it('returns 400 invalid_payload on non-JSON body', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const req = makeReq({
      authHeader: `Bearer ${TOKEN}`,
      body: 'not-json {{{',
    });
    const res = await POST(req as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_payload');
    expect(rows).toHaveLength(0);
  });

  it('returns 400 invalid_payload on missing idempotency_key', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const req = makeReq({
      authHeader: `Bearer ${TOKEN}`,
      body: {
        event: 'tenant.touched',
        tenant_id: 't_1',
        occurred_at: new Date().toISOString(),
      },
    });
    const res = await POST(req as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.details.fields).toContain('idempotency_key');
    expect(rows).toHaveLength(0);
  });
});

// ============================================================================
// Niveau 2 du tenant sync — events suspended/resumed/etc. dispatchés depuis
// la table `prospectionHandlers` extraite (ticket
// todo/2026-05-20-tenant-sync-strategy.md).
//
// Garde-fou anti-régression du refactor route → module : on vérifie que la
// route délègue bien aux helpers `lib/sync/snapshot-updater` via les nouveaux
// handlers, et que la row dedup est persistée + marquée processed_at malgré
// le passage par les helpers.
// ============================================================================

describe('POST /api/webhooks/prospection — Niveau 2 sync events', () => {
  it('dispatches tenant.suspended → applySuspended(prospection) + row persisted', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const body = {
      event: 'tenant.suspended',
      tenant_id: 't_prospection_1',
      data: { suspended_at: '2026-05-23T10:00:00Z', reason: 'admin' },
      idempotency_key: uuid('sync-susp'),
      occurred_at: '2026-05-23T10:00:01Z',
      contract_version: '1.4',
    };
    const res = await POST(
      makeReq({ authHeader: `Bearer ${TOKEN}`, body }) as any,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).dispatched).toBe(true);
    expect(syncMocks.applySuspended).toHaveBeenCalledWith(
      'prospection',
      't_prospection_1',
      { suspended_at: '2026-05-23T10:00:00Z', reason: 'admin' },
      '2026-05-23T10:00:01Z',
    );
    expect(rows[0].eventType).toBe('tenant.suspended');
    expect(rows[0].processedAt).toBeInstanceOf(Date);
  });

  it('dispatches tenant.resumed → applyResumed(prospection)', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const body = {
      event: 'tenant.resumed',
      tenant_id: 't_prospection_2',
      data: { resumed_at: '2026-05-23T12:00:00Z' },
      idempotency_key: uuid('sync-resu'),
      occurred_at: '2026-05-23T12:00:01Z',
      contract_version: '1.4',
    };
    const res = await POST(
      makeReq({ authHeader: `Bearer ${TOKEN}`, body }) as any,
    );
    expect(res.status).toBe(200);
    expect(syncMocks.applyResumed).toHaveBeenCalledWith(
      'prospection',
      't_prospection_2',
      { resumed_at: '2026-05-23T12:00:00Z' },
      '2026-05-23T12:00:01Z',
    );
  });

  it('dispatches tenant.member_added → applyMemberEvent(prospection, added)', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    const body = {
      event: 'tenant.member_added',
      tenant_id: 't_prospection_3',
      data: { user_email: 'm@x.com', role: 'member' },
      idempotency_key: uuid('sync-mem'),
      occurred_at: '2026-05-23T17:00:00Z',
      contract_version: '1.4',
    };
    const res = await POST(
      makeReq({ authHeader: `Bearer ${TOKEN}`, body }) as any,
    );
    expect(res.status).toBe(200);
    expect(syncMocks.applyMemberEvent).toHaveBeenCalledWith(
      'prospection',
      't_prospection_3',
      'added',
      { user_email: 'm@x.com', role: 'member' },
      '2026-05-23T17:00:00Z',
    );
  });

  it('handler throw → 500 + row stays unprocessed (replayable by app)', async () => {
    const { POST } = await import('@/app/api/webhooks/prospection/route');
    syncMocks.applySuspended.mockRejectedValueOnce(new Error('db down'));
    const body = {
      event: 'tenant.suspended',
      tenant_id: 't_throw',
      data: {},
      idempotency_key: uuid('sync-throw'),
      occurred_at: '2026-05-23T10:00:01Z',
      contract_version: '1.4',
    };
    const res = await POST(
      makeReq({ authHeader: `Bearer ${TOKEN}`, body }) as any,
    );
    expect(res.status).toBe(500);
    // La row reste rejouable (processedAt = null) selon la convention §7.1.
    expect(rows[0].processedAt).toBeNull();
  });
});
