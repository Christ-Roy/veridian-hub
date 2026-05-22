/**
 * Tests pour POST /api/admin/impersonate.
 *
 * La route a sa propre `requireAdmin` inlined qui accepte un header
 * `x-admin-secret` matching `process.env.ADMIN_SECRET` — on l'utilise pour
 * bypass l'auth en test sans mocker @/auth en profondeur.
 *
 * Depuis le bouclage LOT D (2026-05-22) : la route ne crée plus de row
 * `Session` (inutile en stratégie JWT) — elle génère un token impersonate
 * via createImpersonationToken (stocké dans verification_tokens) et écrit
 * un audit log `admin.impersonate.start`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const authMock = vi.fn(async () => null);
vi.mock('@/auth', () => ({ auth: authMock }));

vi.mock('@/lib/admin/check-admin', () => ({
  isPlatformAdmin: vi.fn(() => false),
}));

const verificationTokenCreate = vi.fn(async () => ({}));
const auditLogCreate = vi.fn(async () => ({}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        id: 'auth-1',
        supabaseUserId: 'uuid-1',
        email: 'a@test.io',
      })),
    },
    tenant: {
      findFirst: vi.fn(async () => ({
        id: 't1',
        notifuseWorkspaceSlug: 'ws',
        prospectionPlan: 'freemium',
      })),
      update: vi.fn(async () => ({})),
    },
    verificationToken: { create: verificationTokenCreate },
    auditLog: { create: auditLogCreate },
  },
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(null);
  process.env.ADMIN_SECRET = 'test-secret';
  process.env.PROSPECTION_API_URL = 'https://prospection.test';
  process.env.PROSPECTION_TENANT_API_SECRET = 'secret';
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
  globalThis.fetch = vi.fn(async () => new Response(
    JSON.stringify({ login_url: 'https://prospection/api/auth/token?t=xyz' }),
    { status: 200 },
  )) as never;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function makeReq(body: unknown, adminHeader?: string) {
  return {
    json: async () => body,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'x-admin-secret' ? adminHeader ?? null : null),
    },
  } as never;
}

describe('POST /api/admin/impersonate', () => {
  it('refuses without admin header (401)', async () => {
    const { POST } = await import('@/app/api/admin/impersonate/route');
    const res = await POST(makeReq({ email: 'a@test.io' }));
    expect(res.status).toBe(401);
  });

  it('returns links with hub callback + notifuse when admin', async () => {
    const { POST } = await import('@/app/api/admin/impersonate/route');
    const res = await POST(makeReq({ email: 'a@test.io' }, 'test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.links).toHaveProperty('hub');
    expect(body.links.hub).toContain('/api/auth/impersonate-callback?token=');
    expect(body.links).toHaveProperty('notifuse');
    expect(body.links).not.toHaveProperty('twenty');
  });

  it('génère un token impersonate (verification_tokens, pas Session)', async () => {
    const { POST } = await import('@/app/api/admin/impersonate/route');
    await POST(makeReq({ email: 'a@test.io' }, 'test-secret'));
    expect(verificationTokenCreate).toHaveBeenCalledTimes(1);
    const arg = verificationTokenCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.identifier).toBe('impersonate:auth-1');
    // token stocké = hash (64 hex), jamais le brut.
    expect(arg.data.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('écrit un audit log admin.impersonate.start', async () => {
    const { POST } = await import('@/app/api/admin/impersonate/route');
    await POST(makeReq({ email: 'a@test.io' }, 'test-secret'));
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    const arg = auditLogCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.action).toBe('admin.impersonate.start');
    expect(arg.data.targetId).toBe('auth-1');
    expect(arg.data.targetType).toBe('user');
  });

  it('appelle Prospection en HMAC standard (pas de Bearer legacy)', async () => {
    const { POST } = await import('@/app/api/admin/impersonate/route');
    await POST(makeReq({ email: 'a@test.io' }, 'test-secret'));

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(headers['X-Veridian-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-Veridian-Hub-Signature']).toMatch(/^[a-f0-9]{64}$/);
    expect(headers.Authorization).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.user_id).toBe('uuid-1');
    expect(body.metadata).toEqual({ hub_user_id: 'uuid-1' });
  });

  it('refuse une session déjà impersonée (403 — anti ré-impersonation)', async () => {
    // Session platform-admin MAIS marquée impersonated → refus.
    const { isPlatformAdmin } = await import('@/lib/admin/check-admin');
    (isPlatformAdmin as ReturnType<typeof vi.fn>).mockReturnValue(true);
    authMock.mockResolvedValue({
      user: { email: 'admin@veridian.site', impersonated: true },
    } as never);

    const { POST } = await import('@/app/api/admin/impersonate/route');
    // Pas de x-admin-secret → on tombe sur la branche session.
    const res = await POST(makeReq({ email: 'a@test.io' }));
    expect(res.status).toBe(403);
  });
});
