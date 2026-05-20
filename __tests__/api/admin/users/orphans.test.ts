/**
 * Tests pour GET /api/admin/users/orphans
 *
 * Couvre :
 *  - requireAdmin guard (401 si non admin)
 *  - 200 + scan result si admin
 *  - Query params transmis
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findOrphansMock = vi.fn();
const requireAdminMock = vi.fn();

vi.mock('@/lib/admin/find-orphan-users', () => ({
  findOrphanUsers: (...args: unknown[]) => findOrphansMock(...args),
}));

vi.mock('@/lib/admin/require-admin', () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { user: {}, tenant: {} },
}));

beforeEach(() => {
  findOrphansMock.mockReset();
  requireAdminMock.mockReset();
  vi.resetModules();
});

const makeReq = (query = '') =>
  new Request(`http://x/api/admin/users/orphans${query}`);

describe('GET /api/admin/users/orphans', () => {
  it('renvoie le 401/403 de requireAdmin si non autorisé', async () => {
    const denyResponse = new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    requireAdminMock.mockResolvedValueOnce(denyResponse);

    const { GET } = await import('@/app/api/admin/users/orphans/route');
    const res = await GET(makeReq() as never);
    expect(res.status).toBe(403);
    expect(findOrphansMock).not.toHaveBeenCalled();
  });

  it('retourne le scan result quand admin OK', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    findOrphansMock.mockResolvedValueOnce({
      scannedAt: '2026-05-20T00:00:00.000Z',
      minAgeDays: 7,
      totalOrphans: 1,
      orphans: [{ id: 'u1', email: 'a@x', createdAt: new Date(), ageDays: 10 }],
    });

    const { GET } = await import('@/app/api/admin/users/orphans/route');
    const res = await GET(makeReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalOrphans).toBe(1);
    expect(body.orphans).toHaveLength(1);
  });

  it('passe minAgeDays et limit depuis les query params', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    findOrphansMock.mockResolvedValueOnce({
      scannedAt: '2026-05-20T00:00:00.000Z',
      minAgeDays: 14,
      totalOrphans: 0,
      orphans: [],
    });

    const { GET } = await import('@/app/api/admin/users/orphans/route');
    await GET(makeReq('?minAgeDays=14&limit=50') as never);
    expect(findOrphansMock).toHaveBeenCalledWith(
      expect.anything(),
      { minAgeDays: 14, limit: 50 }
    );
  });
});
