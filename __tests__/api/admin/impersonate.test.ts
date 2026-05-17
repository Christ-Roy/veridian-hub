/**
 * Test smoke pour POST /api/admin/impersonate après removal Twenty (2026-05-18).
 *
 * La route impersonate a sa propre `requireAdmin` inlined qui accepte
 * un header `x-admin-secret` matching `process.env.ADMIN_SECRET`. On utilise
 * ce mécanisme pour bypass l'auth en test sans mocker @/auth.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => null),
}));

vi.mock('@/lib/admin/check-admin', () => ({
  isPlatformAdmin: vi.fn(() => false),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        id: 'auth-1',
        supabaseUserId: 'uuid-1',
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
    session: {
      create: vi.fn(async () => ({})),
    },
  },
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_SECRET = 'test-secret';
  process.env.PROSPECTION_API_URL = 'https://prospection.test';
  process.env.PROSPECTION_TENANT_API_SECRET = 'secret';
  globalThis.fetch = vi.fn(async () => new Response(
    JSON.stringify({ login_url: 'https://prospection/api/auth/token?t=xyz' }),
    { status: 200 },
  )) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function makeReq(body: any, adminHeader?: string) {
  return {
    json: async () => body,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'x-admin-secret' ? adminHeader ?? null : null),
    },
  } as any;
}

describe('POST /api/admin/impersonate', () => {
  it('refuses without admin header (401)', async () => {
    const { POST } = await import('@/app/api/admin/impersonate/route');
    const res = await POST(makeReq({ email: 'a@test.io' }));
    expect(res.status).toBe(401);
  });

  it('returns links without twenty key when admin', async () => {
    const { POST } = await import('@/app/api/admin/impersonate/route');
    const res = await POST(makeReq({ email: 'a@test.io' }, 'test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.links).toHaveProperty('hub');
    expect(body.links).toHaveProperty('notifuse');
    expect(body.links).not.toHaveProperty('twenty');
  });
});
