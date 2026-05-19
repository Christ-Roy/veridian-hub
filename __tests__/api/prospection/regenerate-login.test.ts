/**
 * Test POST /api/prospection/regenerate-login après migration HMAC standard
 * 2026-05-19. La route utilise désormais createProspectionClientFromEnv()
 * (HMAC headers, plus de Bearer legacy).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('@/lib/auth/get-user', () => ({
  requireUser: vi.fn(async () => ({
    id: 'auth-1',
    email: 'a@test.io',
    name: 'Alice',
    supabaseUserId: 'uuid-1',
  })),
  userUuid: (u: any) => u.supabaseUserId,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(async () => ({ id: 't1' })),
      update: vi.fn(async () => ({})),
    },
  },
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PROSPECTION_API_URL = 'https://prospection.test';
  process.env.PROSPECTION_HUB_API_SECRET = 'hub-secret';
  delete process.env.PROSPECTION_TENANT_API_SECRET;
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          login_url: 'https://prospection.test/api/auth/token?t=newtok',
          tenant_id: 't-remote-1',
        }),
        { status: 200 },
      ),
  ) as any;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('POST /api/prospection/regenerate-login', () => {
  it('retourne 200 + login_url + tenant_id quand tout va bien', async () => {
    const { POST } = await import('@/app/api/prospection/regenerate-login/route');
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.login_url).toBe(
      'https://prospection.test/api/auth/token?t=newtok',
    );
    expect(body.tenant_id).toBe('t-remote-1');
  });

  it('appelle Prospection en HMAC standard avec user_id + metadata', async () => {
    const { POST } = await import('@/app/api/prospection/regenerate-login/route');
    await POST();

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://prospection.test/api/tenants/provision');

    const headers = init.headers as Record<string, string>;
    expect(headers['X-Veridian-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-Veridian-Hub-Signature']).toMatch(/^[a-f0-9]{64}$/);
    expect(headers.Authorization).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.email).toBe('a@test.io');
    expect(body.name).toBe('Alice');
    expect(body.user_id).toBe('uuid-1');
    expect(body.metadata).toEqual({ hub_user_id: 'uuid-1' });
  });

  it('retourne 500 si Prospection non configurée', async () => {
    delete process.env.PROSPECTION_API_URL;
    const { POST } = await import('@/app/api/prospection/regenerate-login/route');
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Prospection not configured');
  });

  it('retourne 502 si Prospection répond 4xx', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'invalid sig' }), { status: 401 }),
    ) as any;
    const { POST } = await import('@/app/api/prospection/regenerate-login/route');
    const res = await POST();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/Provision failed/);
  });
});
