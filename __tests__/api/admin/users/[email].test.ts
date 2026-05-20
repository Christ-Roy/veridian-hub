/**
 * Tests pour GET /api/admin/users/:email
 *
 * Couvre :
 *  - requireAdmin guard (401/403)
 *  - 400 si email param invalide
 *  - 404 si user inexistant
 *  - 200 + state complet (user + tenants) si OK
 *  - tenants vides si user n'a pas de supabaseUserId
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueMock = vi.fn();
const findManyMock = vi.fn();
const requireAdminMock = vi.fn();

vi.mock('@/lib/admin/require-admin', () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
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
  requireAdminMock.mockReset();
});

const makeReq = () => new Request('http://x/api/admin/users/x');
const makeCtx = (email: string) => ({ params: Promise.resolve({ email }) });

describe('GET /api/admin/users/:email', () => {
  it('renvoie le denyResponse de requireAdmin si non autorisé', async () => {
    requireAdminMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    );
    const { GET } = await import('@/app/api/admin/users/[email]/route');
    const res = await GET(makeReq() as never, makeCtx('a@x.com') as never);
    expect(res.status).toBe(401);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('400 si email param invalide', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/admin/users/[email]/route');
    const res = await GET(makeReq() as never, makeCtx('not-an-email') as never);
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('404 si user inexistant', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/admin/users/[email]/route');
    const res = await GET(makeReq() as never, makeCtx('ghost@x.com') as never);
    expect(res.status).toBe(404);
  });

  it('200 + state complet user + tenants', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: 'u1',
      email: 'a@x.com',
      name: 'Alice',
      emailVerified: null,
      mfaEnabled: false,
      supabaseUserId: 'uuid-1',
      createdAt: new Date('2026-01-01'),
      accounts: [{ provider: 'google', providerAccountId: 'g-1', type: 'oauth' }],
      sessions: [{ expires: new Date() }],
    });
    findManyMock.mockResolvedValueOnce([
      { id: 't1', name: 'X', slug: 'x', status: 'active', metadata: { cms: {} } },
    ]);

    const { GET } = await import('@/app/api/admin/users/[email]/route');
    const res = await GET(makeReq() as never, makeCtx('a@x.com') as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe('a@x.com');
    expect(body.user.providers).toHaveLength(1);
    expect(body.user.active_sessions).toBe(1);
    expect(body.tenants).toHaveLength(1);
  });

  it('tenants=[] si user sans supabaseUserId', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
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
    const { GET } = await import('@/app/api/admin/users/[email]/route');
    const res = await GET(makeReq() as never, makeCtx('a@x.com') as never);
    const body = await res.json();
    expect(body.tenants).toEqual([]);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
