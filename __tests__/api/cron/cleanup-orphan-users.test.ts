/**
 * Tests pour POST /api/cron/cleanup-orphan-users (dry-run only).
 *
 * Couvre :
 *  - CRON_SECRET absent → 500
 *  - Mauvais secret → 401
 *  - Secret OK → 200 + résultat JSON
 *  - Dry-run : pas de delete (vérifié par absence du mock delete)
 *  - Query params minAgeDays/limit transmis
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findOrphansMock = vi.fn();
const deleteUserMock = vi.fn();

vi.mock('@/lib/admin/find-orphan-users', () => ({
  findOrphanUsers: (...args: unknown[]) => findOrphansMock(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { delete: deleteUserMock, deleteMany: deleteUserMock },
  },
}));

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  findOrphansMock.mockReset();
  deleteUserMock.mockReset();
  process.env.CRON_SECRET = 'test-secret-123';
  vi.resetModules();
});

const makeReq = (auth: string | null, query = '') => {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.authorization = auth;
  return new Request(`http://x/api/cron/cleanup-orphan-users${query}`, {
    method: 'POST',
    headers,
  });
};

describe('POST /api/cron/cleanup-orphan-users', () => {
  it('retourne 500 si CRON_SECRET non configuré', async () => {
    delete process.env.CRON_SECRET;
    const { POST } = await import('@/app/api/cron/cleanup-orphan-users/route');
    const res = await POST(makeReq('Bearer x') as never);
    expect(res.status).toBe(500);
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  it('retourne 401 si mauvais secret', async () => {
    const { POST } = await import('@/app/api/cron/cleanup-orphan-users/route');
    const res = await POST(makeReq('Bearer wrong') as never);
    expect(res.status).toBe(401);
    expect(findOrphansMock).not.toHaveBeenCalled();
  });

  it('retourne 401 si pas de header Authorization', async () => {
    const { POST } = await import('@/app/api/cron/cleanup-orphan-users/route');
    const res = await POST(makeReq(null) as never);
    expect(res.status).toBe(401);
  });

  it('retourne 200 et le résultat scan en JSON quand secret OK', async () => {
    findOrphansMock.mockResolvedValueOnce({
      scannedAt: '2026-05-20T00:00:00.000Z',
      minAgeDays: 7,
      totalOrphans: 2,
      orphans: [
        { id: 'u1', email: 'a@x', createdAt: new Date(), ageDays: 10 },
        { id: 'u2', email: 'b@x', createdAt: new Date(), ageDays: 8 },
      ],
    });

    const { POST } = await import('@/app/api/cron/cleanup-orphan-users/route');
    const res = await POST(makeReq('Bearer test-secret-123') as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('dry-run');
    expect(body.totalOrphans).toBe(2);
    expect(body.orphans).toHaveLength(2);
    // Vérifie absolument qu'aucun delete n'a été tenté
    expect(deleteUserMock).not.toHaveBeenCalled();
  });

  it('passe minAgeDays et limit depuis les query params à findOrphanUsers', async () => {
    findOrphansMock.mockResolvedValueOnce({
      scannedAt: '2026-05-20T00:00:00.000Z',
      minAgeDays: 30,
      totalOrphans: 0,
      orphans: [],
    });

    const { POST } = await import('@/app/api/cron/cleanup-orphan-users/route');
    await POST(makeReq('Bearer test-secret-123', '?minAgeDays=30&limit=500') as never);
    expect(findOrphansMock).toHaveBeenCalledWith(
      expect.anything(),
      { minAgeDays: 30, limit: 500 }
    );
  });

  it("garantit qu'aucune méthode prisma.user.delete* n'est appelée (dry-run strict)", async () => {
    findOrphansMock.mockResolvedValueOnce({
      scannedAt: '2026-05-20T00:00:00.000Z',
      minAgeDays: 7,
      totalOrphans: 100,
      orphans: Array.from({ length: 100 }, (_, i) => ({
        id: `u${i}`,
        email: `${i}@x`,
        createdAt: new Date(),
        ageDays: 10,
      })),
    });
    const { POST } = await import('@/app/api/cron/cleanup-orphan-users/route');
    await POST(makeReq('Bearer test-secret-123') as never);
    expect(deleteUserMock).not.toHaveBeenCalled();
  });
});
