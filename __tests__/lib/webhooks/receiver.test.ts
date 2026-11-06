/**
 * Tests unitaires du receveur factorisé `lib/webhooks/receiver.ts` (v1.4).
 *
 * Couvre :
 *   - 401 sans header Authorization
 *   - 401 avec Bearer malformé (pas "Bearer ", token vide)
 *   - 401 avec mauvais token (taille égale + taille différente)
 *   - 400 body non-JSON
 *   - 400 champs requis manquants (event, tenant_id, idempotency_key invalide,
 *     occurred_at)
 *   - 200 happy path + persist + processedAt + handler called
 *   - 200 handler inconnu → dispatched=false mais persist + processedAt
 *   - 200 replay (PK violation P2002) → deduplicated=true
 *   - 500 si handler throw → row reste pending (processedAt = null)
 *   - extractBearer : variants de format
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const TOKEN = 'a'.repeat(64);

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
          // Simuler erreur Prisma P2002 (unique constraint)
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

beforeEach(() => {
  rows.length = 0;
  vi.clearAllMocks();
});

function uuid(seed: string): string {
  // UUID v4 stable mais "fake" — convertit le seed en hex via codes ASCII.
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
  return new Request('https://hub.veridian.site/api/webhooks/test', {
    method: 'POST',
    headers,
    body,
  });
}

describe('lib/webhooks/receiver — extractBearer', () => {
  it('returns null when header missing', async () => {
    const { extractBearer } = await import('@/lib/webhooks/receiver');
    expect(extractBearer(null)).toBeNull();
    expect(extractBearer('')).toBeNull();
  });

  it('returns null without "Bearer " prefix', async () => {
    const { extractBearer } = await import('@/lib/webhooks/receiver');
    expect(extractBearer('Token xyz')).toBeNull();
    expect(extractBearer('xyz')).toBeNull();
  });

  it('returns null on empty token', async () => {
    const { extractBearer } = await import('@/lib/webhooks/receiver');
    expect(extractBearer('Bearer ')).toBeNull();
    expect(extractBearer('Bearer    ')).toBeNull();
  });

  it('extracts the token', async () => {
    const { extractBearer } = await import('@/lib/webhooks/receiver');
    expect(extractBearer('Bearer abc123')).toBe('abc123');
    expect(extractBearer('bearer abc123')).toBe('abc123');
    expect(extractBearer('Bearer   abc123  ')).toBe('abc123');
  });
});

describe('lib/webhooks/receiver — handleWebhook auth', () => {
  it('returns 401 without Authorization header', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const res = await handleWebhook(
      makeReq({ authHeader: null, body: {} }),
      { app: 'test', expectedToken: TOKEN, handlers: {} },
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('unauthorized');
  });

  it('returns 401 on malformed Authorization header', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const res = await handleWebhook(
      makeReq({ authHeader: 'NotBearer xyz', body: {} }),
      { app: 'test', expectedToken: TOKEN, handlers: {} },
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 on wrong token (same length)', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const wrong = 'b'.repeat(64);
    const res = await handleWebhook(
      makeReq({ authHeader: `Bearer ${wrong}`, body: {} }),
      { app: 'test', expectedToken: TOKEN, handlers: {} },
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 on wrong token (different length)', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const res = await handleWebhook(
      makeReq({ authHeader: 'Bearer short', body: {} }),
      { app: 'test', expectedToken: TOKEN, handlers: {} },
    );
    expect(res.status).toBe(401);
  });
});

describe('lib/webhooks/receiver — handleWebhook validation', () => {
  function authReq(body: string | object): Request {
    return makeReq({ authHeader: `Bearer ${TOKEN}`, body });
  }

  it('returns 400 on non-JSON body', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const res = await handleWebhook(authReq('not json {{{'), {
      app: 'test',
      expectedToken: TOKEN,
      handlers: {},
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_payload');
  });

  it('returns 400 on missing event', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const res = await handleWebhook(
      authReq({
        tenant_id: 't_1',
        idempotency_key: uuid('aaa'),
        occurred_at: new Date().toISOString(),
      }),
      { app: 'test', expectedToken: TOKEN, handlers: {} },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.details.fields).toContain('event');
  });

  it('returns 400 on missing tenant_id', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const res = await handleWebhook(
      authReq({
        event: 'tenant.touched',
        idempotency_key: uuid('bbb'),
        occurred_at: new Date().toISOString(),
      }),
      { app: 'test', expectedToken: TOKEN, handlers: {} },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.details.fields).toContain('tenant_id');
  });

  it('returns 400 on invalid idempotency_key (not UUID)', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const res = await handleWebhook(
      authReq({
        event: 'tenant.touched',
        tenant_id: 't_1',
        idempotency_key: 'not-a-uuid',
        occurred_at: new Date().toISOString(),
      }),
      { app: 'test', expectedToken: TOKEN, handlers: {} },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.details.fields).toContain('idempotency_key');
  });

  it('returns 400 on missing occurred_at', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const res = await handleWebhook(
      authReq({
        event: 'tenant.touched',
        tenant_id: 't_1',
        idempotency_key: uuid('ccc'),
      }),
      { app: 'test', expectedToken: TOKEN, handlers: {} },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.details.fields).toContain('occurred_at');
  });

  it('returns 400 when body is not an object', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const res = await handleWebhook(authReq('"just a string"'), {
      app: 'test',
      expectedToken: TOKEN,
      handlers: {},
    });
    expect(res.status).toBe(400);
  });
});

describe('lib/webhooks/receiver — dispatch & dedup', () => {
  function validPayload(seed: string, event = 'tenant.touched') {
    return {
      event,
      tenant_id: 't_1',
      data: { foo: 'bar' },
      idempotency_key: uuid(seed),
      occurred_at: new Date().toISOString(),
      contract_version: '1.4',
    };
  }

  function authReq(body: object): Request {
    return makeReq({ authHeader: `Bearer ${TOKEN}`, body });
  }

  it('happy path : persists, dispatches, marks processed', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const handler = vi.fn();
    const body = validPayload('happy');
    const res = await handleWebhook(authReq(body), {
      app: 'test',
      expectedToken: TOKEN,
      handlers: { 'tenant.touched': handler },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, accepted: true, dispatched: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].processedAt).toBeInstanceOf(Date);
  });

  it('replay (same idempotency_key) returns 200 deduplicated', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const handler = vi.fn();
    const body = validPayload('replay');
    const cfg = {
      app: 'test',
      expectedToken: TOKEN,
      handlers: { 'tenant.touched': handler },
    };
    const r1 = await handleWebhook(authReq(body), cfg);
    expect(r1.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);

    const r2 = await handleWebhook(authReq(body), cfg);
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2).toMatchObject({ ok: true, deduplicated: true });
    // Handler ne doit PAS être ré-appelé
    expect(handler).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it('unknown handler : persists + marks processed + dispatched=false', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const body = validPayload('unknown', 'tenant.unknown_event');
    const res = await handleWebhook(authReq(body), {
      app: 'test',
      expectedToken: TOKEN,
      handlers: {},
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, accepted: true, dispatched: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].processedAt).toBeInstanceOf(Date);
  });

  it('handler throws : returns 500, row stays unprocessed', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const handler = vi.fn(() => {
      throw new Error('boom');
    });
    const body = validPayload('throw');
    const res = await handleWebhook(authReq(body), {
      app: 'test',
      expectedToken: TOKEN,
      handlers: { 'tenant.touched': handler },
    });
    expect(res.status).toBe(500);
    expect(rows).toHaveLength(1);
    expect(rows[0].processedAt).toBeNull();
  });

  it('isolates dedup per app : same idempotency_key on different apps is OK', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const key = uuid('isol');
    const handler = vi.fn();
    const body = {
      event: 'tenant.touched',
      tenant_id: 't_1',
      idempotency_key: key,
      occurred_at: new Date().toISOString(),
    };
    const r1 = await handleWebhook(authReq(body), {
      app: 'notifuse',
      expectedToken: TOKEN,
      handlers: { 'tenant.touched': handler },
    });
    expect(r1.status).toBe(200);
    const r2 = await handleWebhook(authReq(body), {
      app: 'prospection',
      expectedToken: TOKEN,
      handlers: { 'tenant.touched': handler },
    });
    expect(r2.status).toBe(200);
    expect(rows).toHaveLength(2);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Double acceptation pendant une fenêtre de rotation
// ============================================================================
//
// Le receveur doit accepter l'ANCIENNE et la NOUVELLE valeur pendant la
// bascule, sinon rotationner un secret coupe le trafic le temps que tous les
// émetteurs soient redéployés. Ces tests exercent le vrai chemin (auth →
// dédup → dispatch), pas seulement la comparaison de chaînes.
//
// Les deux moitiés comptent : accepter l'héritée pendant la fenêtre, et la
// REFUSER une fois la fenêtre fermée. Sans la seconde, la rotation n'a rien
// changé et le secret publié reste utilisable.

describe('lib/webhooks/receiver — double acceptation (rotation)', () => {
  const CURRENT = 'c'.repeat(64);
  const PREVIOUS = 'p'.repeat(64);
  const OPEN = { current: CURRENT, previous: PREVIOUS };
  const CLOSED = { current: CURRENT, previous: null };

  function payload(seed: string) {
    return {
      event: 'tenant.touched',
      tenant_id: 't_rotation',
      idempotency_key: uuid(seed),
      occurred_at: new Date().toISOString(),
      contract_version: '1.4',
    };
  }

  it('accepte la valeur COURANTE pendant la fenêtre et dispatche', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const handler = vi.fn();
    const res = await handleWebhook(
      makeReq({ authHeader: `Bearer ${CURRENT}`, body: payload('rot-cur') }),
      { app: 'test', expectedToken: OPEN, handlers: { 'tenant.touched': handler } },
    );
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    // L'effet métier doit avoir eu lieu, pas seulement l'authentification.
    expect(rows).toHaveLength(1);
    expect(rows[0].processedAt).not.toBeNull();
  });

  it('accepte la valeur HÉRITÉE pendant la fenêtre et dispatche', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const handler = vi.fn();
    const res = await handleWebhook(
      makeReq({ authHeader: `Bearer ${PREVIOUS}`, body: payload('rot-prev') }),
      { app: 'test', expectedToken: OPEN, handlers: { 'tenant.touched': handler } },
    );
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it('REFUSE la valeur héritée une fois la fenêtre fermée', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const handler = vi.fn();
    const res = await handleWebhook(
      makeReq({ authHeader: `Bearer ${PREVIOUS}`, body: payload('rot-closed') }),
      { app: 'test', expectedToken: CLOSED, handlers: { 'tenant.touched': handler } },
    );
    expect(res.status).toBe(401);
    // Rien ne doit avoir été persisté ni dispatché sur un refus.
    expect(handler).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it('refuse une valeur tierce même pendant la fenêtre', async () => {
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const res = await handleWebhook(
      makeReq({ authHeader: `Bearer ${'z'.repeat(64)}`, body: payload('rot-third') }),
      { app: 'test', expectedToken: OPEN, handlers: {} },
    );
    expect(res.status).toBe(401);
    expect(rows).toHaveLength(0);
  });

  it('reste compatible avec la forme string (rotation fermée)', async () => {
    // Les appelants qui passent encore une string ne doivent pas casser.
    const { handleWebhook } = await import('@/lib/webhooks/receiver');
    const handler = vi.fn();
    const ok = await handleWebhook(
      makeReq({ authHeader: `Bearer ${TOKEN}`, body: payload('rot-str-ok') }),
      { app: 'test', expectedToken: TOKEN, handlers: { 'tenant.touched': handler } },
    );
    expect(ok.status).toBe(200);
    const ko = await handleWebhook(
      makeReq({ authHeader: `Bearer ${PREVIOUS}`, body: payload('rot-str-ko') }),
      { app: 'test', expectedToken: TOKEN, handlers: {} },
    );
    expect(ko.status).toBe(401);
  });
});
