/**
 * Tests pour POST /api/admin/users-lookup
 *
 * Couvre :
 *  - authenticateAdmin guard (401/403)
 *  - 400 si JSON invalide
 *  - 400 si body invalide (email manquant ou format invalide)
 *  - 404 si user inexistant
 *  - 200 + state complet (user + tenants) si OK
 *  - tenants=[] si user sans supabaseUserId
 *  - normalisation email (lowercase + trim)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueMock = vi.fn();
const findManyMock = vi.fn();
const authenticateAdminMock = vi.fn();

vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: (...args: unknown[]) => authenticateAdminMock(...args),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: findUniqueMock },
    tenant: { findMany: findManyMock },
  },
}));

beforeEach(() => {
  findUniqueMock.mockReset();
  findManyMock.mockReset();
  authenticateAdminMock.mockReset();
});

const makeReq = (body: unknown) =>
  new Request('http://x/api/admin/users-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const authOK = { ok: true, sessionEmail: null };
const authDenied = {
  ok: false,
  response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
};

describe('POST /api/admin/users-lookup', () => {
  it('renvoie le denyResponse de authenticateAdmin si non autorisé', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied);
    const { POST } = await import('@/app/api/admin/users-lookup/route');
    const res = await POST(makeReq({ email: 'a@x.com' }) as never);
    expect(res.status).toBe(401);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('400 si JSON invalide', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    const { POST } = await import('@/app/api/admin/users-lookup/route');
    const res = await POST(makeReq('not json') as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_json');
  });

  it('400 si body sans email', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    const { POST } = await import('@/app/api/admin/users-lookup/route');
    const res = await POST(makeReq({}) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
  });

  it('400 si email format invalide', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    const { POST } = await import('@/app/api/admin/users-lookup/route');
    const res = await POST(makeReq({ email: 'not-an-email' }) as never);
    expect(res.status).toBe(400);
  });

  it('404 si user inexistant', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    findUniqueMock.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/admin/users-lookup/route');
    const res = await POST(makeReq({ email: 'ghost@x.com' }) as never);
    expect(res.status).toBe(404);
  });

  it('200 + state complet user + tenants', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    findUniqueMock.mockResolvedValueOnce({
      id: 'u1',
      email: 'a@x.com',
      name: 'Alice',
      emailVerified: null,
      mfaEnabled: true,
      supabaseUserId: 'uuid-1',
      createdAt: new Date('2026-01-01'),
      accounts: [{ provider: 'google', providerAccountId: 'g-1', type: 'oauth' }],
      sessions: [{ expires: new Date() }, { expires: new Date() }],
    });
    findManyMock.mockResolvedValueOnce([
      {
        id: 't1',
        name: 'Workspace X',
        slug: 'x',
        status: 'active',
        notifuseWorkspaceSlug: 'wks-x',
        notifusePlan: 'pro',
        prospectionPlan: 'pro',
        prospectionProvisionedAt: new Date(),
        metadata: {},
        provisionedAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const { POST } = await import('@/app/api/admin/users-lookup/route');
    const res = await POST(makeReq({ email: 'a@x.com' }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe('a@x.com');
    expect(body.user.mfa_enabled).toBe(true);
    expect(body.user.active_sessions).toBe(2);
    expect(body.user.providers).toHaveLength(1);
    expect(body.tenants).toHaveLength(1);
    expect(body.tenants[0].notifusePlan).toBe('pro');
  });

  it('tenants=[] si user sans supabaseUserId', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    findUniqueMock.mockResolvedValueOnce({
      id: 'u1',
      email: 'a@x.com',
      name: null,
      emailVerified: null,
      mfaEnabled: false,
      supabaseUserId: null,
      createdAt: new Date(),
      accounts: [],
      sessions: [],
    });
    const { POST } = await import('@/app/api/admin/users-lookup/route');
    const res = await POST(makeReq({ email: 'a@x.com' }) as never);
    const body = await res.json();
    expect(body.tenants).toEqual([]);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('normalise email lowercase + trim avant lookup DB', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    findUniqueMock.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/admin/users-lookup/route');
    await POST(makeReq({ email: '  Alice@Example.COM  ' }) as never);
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'alice@example.com' } }),
    );
  });
});
