/**
 * Tests pour GET /api/admin/prospect-scores
 *
 * Couvre :
 *  - auth : 401/403 via requireAdmin, et la DB n'est PAS touchée si refus
 *  - tri engagementScore DESC (exploite l'index existant)
 *  - filtre workspace (?workspace / ?workspaceSlug)
 *  - filtre minScore (gte) + clamp ≥ 0
 *  - limit clampé (1..200, défaut 50)
 *  - offset (pagination simple)
 *  - réponse { items, total, limit, offset } + no PII brute (que l'agrégat)
 *  - header Cache-Control: no-store
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAdminMock = vi.fn(async () => null as unknown);
const countMock = vi.fn(async () => 0);
const findManyMock = vi.fn(async () => [] as unknown[]);

vi.mock('@/lib/admin/require-admin', () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    prospectScore: {
      count: (...args: unknown[]) => countMock(...args),
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue(null);
  countMock.mockResolvedValue(0);
  findManyMock.mockResolvedValue([]);
});

const makeReq = (query = '') =>
  new Request(`http://x/api/admin/prospect-scores${query}`);

/** Rangées factices décroissantes en score. */
const fakeRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    contactEmail: `p${i}@x.com`,
    workspaceSlug: 'ws-a',
    engagementScore: 100 - i,
    signals: { opened: 1, clicked: 0, replied: 0, page_hit: 0 },
    lastEventAt: new Date('2026-06-16T10:00:00Z'),
    vid: `vid-${i}`,
    tenantUuid: '00000000-0000-0000-0000-000000000000',
  }));

describe('GET /api/admin/prospect-scores — auth', () => {
  it('renvoie 401 (deny requireAdmin) et ne touche pas la DB', async () => {
    requireAdminMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    const res = await GET(makeReq() as never);
    expect(res.status).toBe(401);
    expect(countMock).not.toHaveBeenCalled();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('renvoie 403 (session non-admin) et ne touche pas la DB', async () => {
    requireAdminMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
    );
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    const res = await GET(makeReq() as never);
    expect(res.status).toBe(403);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/prospect-scores — tri & réponse', () => {
  it('200, tri engagementScore DESC, forme { items, total, limit, offset }', async () => {
    countMock.mockResolvedValueOnce(3);
    findManyMock.mockResolvedValueOnce(fakeRows(3));
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    const res = await GET(makeReq() as never);
    expect(res.status).toBe(200);

    // L'orderBy doit mener avec engagementScore desc (exploite l'index).
    const call = findManyMock.mock.calls[0]?.[0] as { orderBy?: unknown[] };
    expect(call.orderBy?.[0]).toEqual({ engagementScore: 'desc' });

    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items[0].engagementScore).toBeGreaterThanOrEqual(
      body.items[1].engagementScore,
    );
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
  });

  it('chaque item porte l\'agrégat attendu et AUCUN payload event brut (PII)', async () => {
    countMock.mockResolvedValueOnce(1);
    findManyMock.mockResolvedValueOnce(fakeRows(1));
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    const res = await GET(makeReq() as never);
    const body = await res.json();
    const item = body.items[0];
    expect(item).toMatchObject({
      contactEmail: 'p0@x.com',
      workspaceSlug: 'ws-a',
      engagementScore: 100,
      vid: 'vid-0',
      tenantUuid: '00000000-0000-0000-0000-000000000000',
    });
    expect(item).toHaveProperty('signals');
    expect(item).toHaveProperty('lastEventAt');
    // Pas de fuite de payload brut d'event.
    expect(item).not.toHaveProperty('data');
    expect(item).not.toHaveProperty('idempotencyKey');
    // Le select Prisma ne demande QUE l'agrégat (pas les events).
    const call = findManyMock.mock.calls[0]?.[0] as { select?: Record<string, boolean> };
    expect(call.select).not.toHaveProperty('data');
  });

  it('pose le header Cache-Control: no-store', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    const res = await GET(makeReq() as never);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('GET /api/admin/prospect-scores — filtres', () => {
  it('sans filtre → where vide', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    await GET(makeReq() as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
    expect(countMock).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it('?workspace=ws-a → where.workspaceSlug', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    await GET(makeReq('?workspace=ws-a') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceSlug: 'ws-a' } }),
    );
  });

  it('?workspaceSlug=ws-b (alias long) → where.workspaceSlug', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    await GET(makeReq('?workspaceSlug=ws-b') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceSlug: 'ws-b' } }),
    );
  });

  it('?minScore=10 → where.engagementScore gte 10', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    await GET(makeReq('?minScore=10') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { engagementScore: { gte: 10 } } }),
    );
  });

  it('?minScore=0 → pas de filtre score (where vide)', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    await GET(makeReq('?minScore=0') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('?minScore=-5 → clampé à 0, pas de filtre score', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    await GET(makeReq('?minScore=-5') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('workspace + minScore combinés → where complet', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    await GET(makeReq('?workspace=ws-a&minScore=20') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceSlug: 'ws-a', engagementScore: { gte: 20 } },
      }),
    );
  });
});

describe('GET /api/admin/prospect-scores — limit & offset', () => {
  it('limit par défaut 50', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    await GET(makeReq() as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, skip: 0 }),
    );
  });

  it('clamp limit > 200 à 200', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    await GET(makeReq('?limit=9999') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it('clamp limit < 1 à 1', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    await GET(makeReq('?limit=0') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });

  it('limit non numérique → fallback 50', async () => {
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    await GET(makeReq('?limit=abc') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it('?offset=25 → skip 25 et reflété dans la réponse', async () => {
    countMock.mockResolvedValueOnce(100);
    const { GET } = await import('@/app/api/admin/prospect-scores/route');
    const res = await GET(makeReq('?offset=25&limit=10') as never);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 25, take: 10 }),
    );
    const body = await res.json();
    expect(body.offset).toBe(25);
    expect(body.limit).toBe(10);
  });
});
