/**
 * Tests pour GET /api/admin/oauth-events
 *
 * Couvre :
 *  - auth required (401) — la route ne touche PAS la DB si non autorisé
 *  - filtres provider / event / email passés au where Prisma
 *  - event invalide ignoré (dégradation tolérante, pas 400)
 *  - limit clampé entre 1 et 500
 *  - pagination keyset : take = limit+1, has_more + next_cursor
 *  - cursor passé à Prisma avec skip:1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyMock = vi.fn();
const authenticateAdminMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { oauthSigninEvent: { findMany: findManyMock } },
}));
vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: (...args: unknown[]) => authenticateAdminMock(...args),
}));

const authOK = { ok: true, sessionEmail: null };
const authDenied = {
  ok: false,
  response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
};

beforeEach(() => {
  findManyMock.mockReset();
  authenticateAdminMock.mockReset();
  authenticateAdminMock.mockResolvedValue(authOK);
});

const makeReq = (query = '') =>
  new Request(`http://x/api/admin/oauth-events${query}`);

/** Fabrique N rows factices décroissantes en id. */
const fakeRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `evt-${n - i}`,
    event: 'success',
    provider: 'google',
    email: 'u@x.com',
    createdAt: new Date(),
  }));

describe('GET /api/admin/oauth-events — auth', () => {
  it('renvoie 401 si non autorisé et ne touche pas la DB', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied);
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    const res = await GET(makeReq() as never);
    expect(res.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/oauth-events — filtres', () => {
  it('sans filtre → where vide', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    await GET(makeReq() as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, orderBy: { createdAt: 'desc' } }),
    );
  });

  it('?provider=google&event=failure&email=a@b.c → where complet', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    await GET(makeReq('?provider=google&event=failure&email=a@b.c') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider: 'google', event: 'failure', email: 'a@b.c' },
      }),
    );
  });

  it('?event=garbage → event ignoré (dégradation tolérante, pas dans le where)', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    const res = await GET(makeReq('?event=garbage') as never);
    expect(res.status).toBe(200);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('?event=success est accepté', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    await GET(makeReq('?event=success') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { event: 'success' } }),
    );
  });
});

describe('GET /api/admin/oauth-events — limit', () => {
  it('limit par défaut 100 → take 101 (keyset +1)', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    await GET(makeReq() as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 101 }),
    );
  });

  it('clamp limit > 500 à 500 → take 501', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    await GET(makeReq('?limit=9999') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 501 }),
    );
  });

  it('clamp limit < 1 à 1 → take 2', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    await GET(makeReq('?limit=0') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 }),
    );
  });

  it('limit non numérique → fallback 100 → take 101', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    await GET(makeReq('?limit=abc') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 101 }),
    );
  });
});

describe('GET /api/admin/oauth-events — pagination keyset', () => {
  it('rows ≤ limit → has_more false, next_cursor null', async () => {
    findManyMock.mockResolvedValueOnce(fakeRows(3));
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    const res = await GET(makeReq('?limit=10') as never);
    const body = await res.json();
    expect(body.count).toBe(3);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
    expect(body.events).toHaveLength(3);
  });

  it('rows = limit+1 → has_more true, page tronquée à limit, next_cursor = dernier id', async () => {
    findManyMock.mockResolvedValueOnce(fakeRows(11)); // limit 10 → demande 11
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    const res = await GET(makeReq('?limit=10') as never);
    const body = await res.json();
    expect(body.count).toBe(10);
    expect(body.has_more).toBe(true);
    expect(body.events).toHaveLength(10);
    expect(body.next_cursor).toBe(body.events[9].id);
  });

  it('?cursor=evt-50 → passé à Prisma avec skip:1', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    await GET(makeReq('?cursor=evt-50') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'evt-50' }, skip: 1 }),
    );
  });

  it('sans cursor → pas de clé cursor/skip dans l\'appel Prisma', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/admin/oauth-events/route');
    await GET(makeReq() as never);
    const callArg = findManyMock.mock.calls[0]?.[0] ?? {};
    expect(callArg).not.toHaveProperty('cursor');
    expect(callArg).not.toHaveProperty('skip');
  });
});
