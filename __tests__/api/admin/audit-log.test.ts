/**
 * Tests pour GET /api/admin/audit-log
 *
 * Couvre :
 *  - auth required (401)
 *  - query par actor (utilise findAuditByActor → index)
 *  - query sans actor (last N events)
 *  - limit clamped entre 1 et 500
 *  - since param parsé en Date
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyMock = vi.fn();
const findUniqueMock = vi.fn();
const countMock = vi.fn();
const aggregateMock = vi.fn();
const findAuditByActorMock = vi.fn();
const authenticateAdminMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { auditLog: { findMany: findManyMock, findUnique: findUniqueMock, count: countMock, aggregate: aggregateMock } },
}));
vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: (...args: unknown[]) => authenticateAdminMock(...args),
}));
vi.mock('@/lib/admin/audit-log', () => ({
  findAuditByActor: (...args: unknown[]) => findAuditByActorMock(...args),
}));

const authOK = { ok: true, sessionEmail: null };
const authDenied = {
  ok: false,
  response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
};

beforeEach(() => {
  findManyMock.mockReset();
  findUniqueMock.mockReset().mockResolvedValue({ id: 'a9' });
  countMock.mockReset().mockResolvedValue(7);
  aggregateMock.mockReset().mockResolvedValue({ _count: { _all: 900 }, _min: { createdAt: new Date('2026-05-20T16:00:00Z') } });
  findAuditByActorMock.mockReset();
  authenticateAdminMock.mockReset();
  authenticateAdminMock.mockResolvedValue(authOK);
});

const makeReq = (query = '') =>
  new Request(`http://x/api/admin/audit-log${query}`);

describe('GET /api/admin/audit-log', () => {
  it('renvoie 401 si non autorisé', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied);
    const { GET } = await import('@/app/api/admin/audit-log/route');
    const res = await GET(makeReq() as never);
    expect(res.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(findAuditByActorMock).not.toHaveBeenCalled();
  });

  it('query par actor → utilise findAuditByActor (exerce index actor)', async () => {
    findAuditByActorMock.mockResolvedValueOnce([
      { id: 'a1', action: 'admin.user.create', actor: 'token:ADMIN_SECRET', createdAt: new Date() },
    ]);
    const { GET } = await import('@/app/api/admin/audit-log/route');
    const res = await GET(makeReq('?actor=token:ADMIN_SECRET&limit=50') as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actor).toBe('token:ADMIN_SECRET');
    expect(body.count).toBe(1);
    expect(findAuditByActorMock).toHaveBeenCalledWith(
      expect.anything(),
      'token:ADMIN_SECRET',
      expect.objectContaining({ limit: 50 })
    );
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('query sans actor → findMany direct sur createdAt', async () => {
    findManyMock.mockResolvedValueOnce([
      { id: 'a1', action: 'admin.tenant.link', actor: 'admin:robert@x' },
    ]);
    const { GET } = await import('@/app/api/admin/audit-log/route');
    const res = await GET(makeReq() as never);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(findAuditByActorMock).not.toHaveBeenCalled();
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 })
    );
  });

  it('clamp limit > 500 à 500', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/audit-log/route');
    await GET(makeReq('?limit=9999') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 })
    );
  });

  it('clamp limit < 1 à 1', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/audit-log/route');
    await GET(makeReq('?limit=0') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 })
    );
  });

  it('parse since en Date et filtre createdAt gte', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/audit-log/route');
    await GET(makeReq('?since=2026-05-01T00:00:00Z') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { gte: expect.any(Date) } },
      })
    );
  });

  it('filtre par action, pagine sans trou, et dit ce que le journal couvre', async () => {
    findManyMock.mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }]);
    const { GET } = await import('@/app/api/admin/audit-log/route');
    const body = await (await GET(makeReq('?action=membre.retire,organisation.decochee&limit=2&apres=a9') as never)).json();
    const where = { action: { in: ['membre.retire', 'organisation.decochee'] } };
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ where, cursor: { id: 'a9' }, skip: 1, take: 2 }));
    expect(countMock).toHaveBeenCalledWith({ where });
    expect(body).toMatchObject({ count: 2, filtre: 7, suivant: 'a2', couverture: { total: 900, depuis: '2026-05-20T16:00:00.000Z' } });
  });

  it('dernière page : pas de suivant', async () => {
    findManyMock.mockResolvedValueOnce([{ id: 'a1' }]);
    const { GET } = await import('@/app/api/admin/audit-log/route');
    expect((await (await GET(makeReq('?limit=2') as never)).json()).suivant).toBeNull();
  });

  it('un filtre illisible ou ignoré est refusé, jamais avalé', async () => {
    const { GET } = await import('@/app/api/admin/audit-log/route');
    expect((await GET(makeReq('?since=hier') as never)).status).toBe(400);
    expect((await GET(makeReq('?actor=x&action=membre.retire') as never)).status).toBe(400);
    findUniqueMock.mockResolvedValueOnce(null);
    expect((await GET(makeReq('?apres=inconnu') as never)).status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
