/**
 * Tests des routes admin Notifuse Hub :
 * - POST /api/admin/notifuse/update-plan
 * - POST /api/admin/notifuse/suspend
 * - POST /api/admin/notifuse/resume
 * - DELETE /api/admin/notifuse/delete
 * - GET   /api/admin/notifuse/status
 *
 * On mock `auth`, `isPlatformAdmin`, `prisma` et `fetch` (utilisé par
 * NotifuseClient en interne) pour valider la logique métier sans DB ni réseau.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recente = vi.hoisted(() => ({ ok: true }));
vi.mock('@/lib/auth/recent-auth', () => ({
  isAuthRecent: () => recente.ok,
  PREUVE_COMPTE_S: 86400,
  PREUVE_FACTURATION_S: 604800,
  denyUnlessRecentAuth: vi.fn(async () =>
    recente.ok
      ? null
      : new Response(JSON.stringify({ error: 'recent_auth_required' }), { status: 403 }),
  ),
}));

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'u1', email: 'brunon5robert@gmail.com' } })),
}));

vi.mock('@/lib/admin/check-admin', () => ({
  administrateurDe: vi.fn(async () => ({ userId: 'u1', hubUserId: 'h1', email: 'brunon5robert@gmail.com' })),
}));

const tenantStore: Map<string, any> = new Map();
const provisioningLogs: any[] = [];

// La fusion par la base (lib/tenants/metadata-fusion.ts), simulée : les clés du patch posées, les autres intactes.
vi.mock('@/lib/tenants/metadata-fusion', () => ({
  fusionnerMetadata: vi.fn(async (_db: unknown, id: string, patch: Record<string, unknown>) => {
    const cur = tenantStore.get(id);
    if (!cur) throw new Error('Tenant not found in store');
    tenantStore.set(id, { ...cur, metadata: { ...(cur.metadata ?? {}), ...patch } });
  }),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findUnique: vi.fn(async ({ where }: any) => tenantStore.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const cur = tenantStore.get(where.id);
        if (!cur) throw new Error('Tenant not found in store');
        const merged = { ...cur, ...data };
        tenantStore.set(where.id, merged);
        return merged;
      }),
    },
    provisioningLog: {
      create: vi.fn(async ({ data }: any) => {
        provisioningLogs.push(data);
        return { id: `log_${provisioningLogs.length}`, ...data };
      }),
    },
  },
}));

// Mock global fetch — interceptera tous les appels du NotifuseClient.
const fetchMock = vi.fn();

// ============================================================================
// Helpers
// ============================================================================

function makeNextRequest(opts: {
  url?: string;
  method: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}): any {
  const url = opts.url ?? 'http://localhost/api/admin/notifuse/test';
  const headers = new Map<string, string>(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const parsed = new URL(url);
  return {
    url,
    method: opts.method,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    nextUrl: {
      searchParams: parsed.searchParams,
    },
    json: async () => {
      if (opts.body === undefined) throw new Error('No body');
      return opts.body;
    },
    text: async () => (opts.body === undefined ? '' : JSON.stringify(opts.body)),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TENANT_ID = 'tenant_abc';
const NOTIFUSE_SLUG = 'demoorg';

function seedTenant(extra: Record<string, unknown> = {}) {
  tenantStore.set(TENANT_ID, {
    id: TENANT_ID,
    notifuseWorkspaceSlug: NOTIFUSE_SLUG,
    notifuseUserEmail: 'owner@example.com',
    notifuseApiKey: 'nf_key_demo',
    metadata: extra,
  });
}

// ============================================================================
// Setup env + global fetch
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  tenantStore.clear();
  provisioningLogs.length = 0;
  process.env.NOTIFUSE_API_URL = 'https://notifuse.example.com';
  process.env.NOTIFUSE_HUB_API_SECRET = 'test-hub-secret';
  process.env.ADMIN_SECRET = 'test-admin-secret';
  // @ts-expect-error — override global fetch for tests
  global.fetch = fetchMock;
});

// ============================================================================
// Tests
// ============================================================================

describe('DELETE /api/admin/notifuse/delete', () => {
  it('exige confirm: true', async () => {
    seedTenant();
    const { DELETE } = await import('@/app/api/admin/notifuse/delete/route');
    const req = makeNextRequest({
      method: 'DELETE',
      body: { tenantId: TENANT_ID },
    });
    const res: any = await DELETE(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/confirm/);
  });

  it('soft-delete via NotifuseClient et persiste deleted_at', async () => {
    seedTenant();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const { DELETE } = await import('@/app/api/admin/notifuse/delete/route');
    const req = makeNextRequest({
      method: 'DELETE',
      body: { tenantId: TENANT_ID, confirm: true },
    });
    const res: any = await DELETE(req);
    expect(res.status).toBe(200);

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`https://notifuse.example.com/api/tenants/${NOTIFUSE_SLUG}`);
    expect((init as RequestInit).method).toBe('DELETE');

    const tenant = tenantStore.get(TENANT_ID);
    expect(tenant.metadata.notifuse_deleted_at).toBeTruthy();
  });
});

