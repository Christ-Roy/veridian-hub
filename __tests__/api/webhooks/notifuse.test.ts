/**
 * Tests de la route POST /api/webhooks/notifuse (app/api/webhooks/notifuse/route.ts).
 *
 * La route dispatche entre deux formats :
 *
 *  1. v1.4 (Bearer token) → délègue à `lib/webhooks/receiver.handleWebhook`.
 *     On mock `handleWebhook` pour vérifier que la route lui passe la bonne
 *     config (`app: 'notifuse'`, `expectedToken`, `handlers` avec les bons keys).
 *
 *  2. Legacy HMAC (headers x-veridian-timestamp + x-veridian-notifuse-signature).
 *     On calcule la VRAIE signature dans le test pour que le check timing-safe
 *     passe, et on mock `prisma.tenant.findFirst`/`prisma.tenant.update` pour
 *     contrôler la branche dédup metadata.notifuse_processed_events.
 *
 * Les assertions vérifient le COMPORTEMENT (status, body shape, args passés
 * aux mocks, side-effects sur le store mock), pas juste "ça ne throw pas".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';

// ============================================================================
// Mocks — déclarés avant l'import dynamique de la route
// ============================================================================

// Mock receiver.handleWebhook pour la branche v1.4. On garde extractBearer
// réel (au cas où) — ici on n'en a pas besoin mais c'est inoffensif.
const handleWebhookMock = vi.fn();
vi.mock('@/lib/webhooks/receiver', () => ({
  handleWebhook: (...args: unknown[]) => handleWebhookMock(...args),
}));

// Mock prisma pour la branche legacy. Le store est rechargé entre les tests.
interface FakeTenant {
  id: string;
  notifuseWorkspaceSlug: string;
  metadata: Record<string, unknown> | null;
  prospectionConfig?: unknown;
}

const tenantStore: Map<string, FakeTenant> = new Map();
const findFirstMock = vi.fn(async ({ where, select: _select }: any) => {
  for (const t of tenantStore.values()) {
    if (t.notifuseWorkspaceSlug === where.notifuseWorkspaceSlug) return t;
  }
  return null;
});
const updateMock = vi.fn(async ({ where, data }: any) => {
  const t = Array.from(tenantStore.values()).find((x) => x.id === where.id);
  if (!t) throw new Error('Tenant not found in mock store');
  t.metadata = { ...(t.metadata ?? {}), ...(data.metadata ?? {}) };
  return t;
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findFirst: (...args: any[]) => findFirstMock(...args),
      update: (...args: any[]) => updateMock(...args),
    },
  },
}));

// ============================================================================
// Helpers
// ============================================================================

const LEGACY_SECRET = 'legacy-test-secret-xyz';
const V14_TOKEN = 'v14-test-bearer-token-abc';

function makeNextRequest(opts: {
  body: string;
  headers?: Record<string, string>;
}): any {
  const headers = new Map<string, string>(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    url: 'http://localhost/api/webhooks/notifuse',
    method: 'POST',
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    text: async () => opts.body,
  };
}

function signLegacy(timestamp: string, rawBody: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

beforeEach(() => {
  tenantStore.clear();
  handleWebhookMock.mockReset();
  findFirstMock.mockClear();
  updateMock.mockClear();
});

afterEach(() => {
  delete process.env.NOTIFUSE_WEBHOOK_TOKEN;
  delete process.env.NOTIFUSE_HUB_WEBHOOK_SECRET;
});

// ============================================================================
// v1.4 — branche Bearer
// ============================================================================

describe('POST /api/webhooks/notifuse — v1.4 (Bearer)', () => {
  it('returns 500 if NOTIFUSE_WEBHOOK_TOKEN env is missing', async () => {
    delete process.env.NOTIFUSE_WEBHOOK_TOKEN;
    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const req = makeNextRequest({
      body: '{}',
      headers: { authorization: 'Bearer anything' },
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('internal_error');
    expect(json.message).toMatch(/NOTIFUSE_WEBHOOK_TOKEN/);
    // handleWebhook NE doit PAS être appelé si l'env manque
    expect(handleWebhookMock).not.toHaveBeenCalled();
  });

  it('delegates to handleWebhook with correct config when Bearer + env present', async () => {
    process.env.NOTIFUSE_WEBHOOK_TOKEN = V14_TOKEN;
    // Mock retourne une Response 200 que la route doit renvoyer telle quelle.
    const fakeResponse = new Response(
      JSON.stringify({ ok: true, accepted: true, dispatched: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    handleWebhookMock.mockResolvedValueOnce(fakeResponse);

    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const req = makeNextRequest({
      body: JSON.stringify({
        event: 'tenant.touched',
        tenant_id: 't_1',
        idempotency_key: '00000000-0000-4000-8000-000000000001',
        emitted_at: '2026-05-21T10:00:00.000Z',
      }),
      headers: { authorization: `Bearer ${V14_TOKEN}` },
    });
    const res = await POST(req);

    expect(res).toBe(fakeResponse);
    expect(res.status).toBe(200);
    expect(handleWebhookMock).toHaveBeenCalledTimes(1);

    const [passedRequest, config] = handleWebhookMock.mock.calls[0];
    // La route doit passer le request original (notre fake req) au receiver
    expect(passedRequest).toBe(req);
    expect(config.app).toBe('notifuse');
    expect(config.expectedToken).toBe(V14_TOKEN);
    // Les handlers v1.4 doivent contenir au moins les 3 events stub définis
    expect(typeof config.handlers).toBe('object');
    expect(Object.keys(config.handlers)).toEqual(
      expect.arrayContaining([
        'tenant.touched',
        'tenant.member_role_changed',
        'tenant.activity_threshold_reached',
      ]),
    );
    // Legacy ne doit PAS avoir été touché
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Legacy HMAC — pas de Bearer
// ============================================================================

describe('POST /api/webhooks/notifuse — Legacy HMAC', () => {
  beforeEach(() => {
    process.env.NOTIFUSE_HUB_WEBHOOK_SECRET = LEGACY_SECRET;
  });

  it('returns 500 if NOTIFUSE_HUB_WEBHOOK_SECRET env is missing', async () => {
    delete process.env.NOTIFUSE_HUB_WEBHOOK_SECRET;
    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const res = await POST(makeNextRequest({ body: '{}' }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toMatch(/NOTIFUSE_HUB_WEBHOOK_SECRET/);
    // Pas de bearer + secret manquant → on ne doit même pas toucher prisma
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it('returns 401 if signature header is absent', async () => {
    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const body = JSON.stringify({
      event_id: 'evt_1',
      event_type: 'tenant.provisioned',
      tenant_id: 't_1',
    });
    const res = await POST(
      makeNextRequest({
        body,
        headers: { 'x-veridian-timestamp': String(Date.now()) },
        // signature absente
      }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Invalid signature');
    // On ne doit pas dispatcher v1.4 ni hit prisma
    expect(handleWebhookMock).not.toHaveBeenCalled();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it('returns 401 if timestamp drift > 5 minutes', async () => {
    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const oldTs = String(Date.now() - 10 * 60 * 1000); // 10 min in the past
    const body = JSON.stringify({
      event_id: 'evt_drift',
      event_type: 'tenant.provisioned',
      tenant_id: 't_1',
    });
    const sig = signLegacy(oldTs, body, LEGACY_SECRET); // signature mathématiquement valide
    const res = await POST(
      makeNextRequest({
        body,
        headers: {
          'x-veridian-timestamp': oldTs,
          'x-veridian-notifuse-signature': sig,
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it('returns 401 if signature is invalid (wrong secret)', async () => {
    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const ts = String(Date.now());
    const body = JSON.stringify({
      event_id: 'evt_wrong',
      event_type: 'tenant.provisioned',
      tenant_id: 't_1',
    });
    // Signature calculée avec un MAUVAIS secret
    const badSig = signLegacy(ts, body, 'wrong-secret');
    const res = await POST(
      makeNextRequest({
        body,
        headers: {
          'x-veridian-timestamp': ts,
          'x-veridian-notifuse-signature': badSig,
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON body even when signature is valid', async () => {
    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const ts = String(Date.now());
    const badBody = 'not valid json {{{';
    const sig = signLegacy(ts, badBody, LEGACY_SECRET);
    const res = await POST(
      makeNextRequest({
        body: badBody,
        headers: {
          'x-veridian-timestamp': ts,
          'x-veridian-notifuse-signature': sig,
        },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Invalid JSON/i);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it('returns 400 on missing required fields (event_id)', async () => {
    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const ts = String(Date.now());
    const body = JSON.stringify({
      // event_id manquant
      event_type: 'tenant.provisioned',
      tenant_id: 't_1',
    });
    const sig = signLegacy(ts, body, LEGACY_SECRET);
    const res = await POST(
      makeNextRequest({
        body,
        headers: {
          'x-veridian-timestamp': ts,
          'x-veridian-notifuse-signature': sig,
        },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Missing required fields/);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it('returns 200 + deduplicated:true when event_id already in tenant.metadata', async () => {
    tenantStore.set('tenant-uuid-1', {
      id: 'tenant-uuid-1',
      notifuseWorkspaceSlug: 't_dedup',
      metadata: { notifuse_processed_events: ['evt_already', 'evt_other'] },
    });

    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const ts = String(Date.now());
    const body = JSON.stringify({
      event_id: 'evt_already',
      event_type: 'tenant.suspended',
      tenant_id: 't_dedup',
      data: { suspended_at: '2026-05-21T10:00:00.000Z', reason: 'test' },
    });
    const sig = signLegacy(ts, body, LEGACY_SECRET);
    const res = await POST(
      makeNextRequest({
        body,
        headers: {
          'x-veridian-timestamp': ts,
          'x-veridian-notifuse-signature': sig,
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, deduplicated: true });
    // On a bien fait le lookup tenant initial (1 fois)
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { notifuseWorkspaceSlug: 't_dedup' },
      }),
    );
    // On ne doit PAS avoir update (deduplicated = early return)
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('dispatches valid event (tenant.suspended) → updates tenant metadata + marks event processed', async () => {
    tenantStore.set('tenant-uuid-2', {
      id: 'tenant-uuid-2',
      notifuseWorkspaceSlug: 't_susp',
      metadata: null,
    });

    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const ts = String(Date.now());
    const body = JSON.stringify({
      event_id: 'evt_susp_1',
      event_type: 'tenant.suspended',
      tenant_id: 't_susp',
      data: {
        suspended_at: '2026-05-21T10:00:00.000Z',
        reason: 'manual_admin',
      },
    });
    const sig = signLegacy(ts, body, LEGACY_SECRET);
    const res = await POST(
      makeNextRequest({
        body,
        headers: {
          'x-veridian-timestamp': ts,
          'x-veridian-notifuse-signature': sig,
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    // 2 lookups : initial idempotence check + dispatchLegacyEvent re-fetch
    expect(findFirstMock).toHaveBeenCalledTimes(2);
    // 2 updates : 1 dans dispatchLegacyEvent (suspended_at + reason),
    // 1 à la fin pour marquer event_id processed.
    expect(updateMock).toHaveBeenCalledTimes(2);

    // Le tenant doit avoir reçu les meta de suspension ET le tracker event_id
    const tenant = tenantStore.get('tenant-uuid-2')!;
    expect(tenant.metadata).toMatchObject({
      notifuse_suspended_at: '2026-05-21T10:00:00.000Z',
      notifuse_suspended_reason: 'manual_admin',
      notifuse_processed_events: expect.arrayContaining(['evt_susp_1']),
    });
  });

  it('email.sent increments notifuse_emails_sent_this_month counter', async () => {
    tenantStore.set('tenant-uuid-3', {
      id: 'tenant-uuid-3',
      notifuseWorkspaceSlug: 't_email',
      metadata: { notifuse_emails_sent_this_month: 41 },
    });

    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const ts = String(Date.now());
    const body = JSON.stringify({
      event_id: 'evt_email_1',
      event_type: 'email.sent',
      tenant_id: 't_email',
      data: {
        message_id: 'msg_abc',
        to: 'foo@bar.com',
        sent_at: '2026-05-21T10:00:00.000Z',
      },
    });
    const sig = signLegacy(ts, body, LEGACY_SECRET);
    const res = await POST(
      makeNextRequest({
        body,
        headers: {
          'x-veridian-timestamp': ts,
          'x-veridian-notifuse-signature': sig,
        },
      }),
    );
    expect(res.status).toBe(200);
    const tenant = tenantStore.get('tenant-uuid-3')!;
    expect((tenant.metadata as any).notifuse_emails_sent_this_month).toBe(42);
    // event_id ajouté aux processed
    expect(
      (tenant.metadata as any).notifuse_processed_events,
    ).toContain('evt_email_1');
  });

  it('returns 200 on unknown tenant_id (no row in DB) without crashing — but still verifies signature', async () => {
    // Aucun tenant inséré dans le store → findFirst renverra null
    const { POST } = await import('@/app/api/webhooks/notifuse/route');
    const ts = String(Date.now());
    const body = JSON.stringify({
      event_id: 'evt_orphan',
      event_type: 'tenant.suspended',
      tenant_id: 't_unknown',
      data: { suspended_at: '2026-05-21T10:00:00.000Z' },
    });
    const sig = signLegacy(ts, body, LEGACY_SECRET);
    const res = await POST(
      makeNextRequest({
        body,
        headers: {
          'x-veridian-timestamp': ts,
          'x-veridian-notifuse-signature': sig,
        },
      }),
    );
    expect(res.status).toBe(200);
    // On a regardé en DB (idempotence + dispatch), mais aucune mise à jour
    expect(findFirstMock).toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
