// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), relever: vi.fn() }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: (...a: unknown[]) => m.admin(...a) }));
vi.mock('@/lib/sync/appartenance', () => ({ releverAppartenance: (...a: unknown[]) => m.relever(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import * as route from '@/app/api/admin/appartenance/route';

const req = (q = '') => new NextRequest(`https://app.veridian.site/api/admin/appartenance${q}`);
beforeEach(() => {
  vi.clearAllMocks();
  m.admin.mockResolvedValue(null);
  m.relever.mockResolvedValue({ app: 'crm', etat: 'ok' });
});

describe('GET /api/admin/appartenance', () => {
  it('refusé sans admin : rien n\'est lu', async () => {
    m.admin.mockResolvedValue(NextResponse.json({}, { status: 401 }));
    expect((await route.GET(req('?app=crm'))).status).toBe(401);
    expect(m.relever).not.toHaveBeenCalled();
  });

  it('une app connue, jamais en cache ; sinon 400', async () => {
    const r = await route.GET(req('?app=crm'));
    expect([r.status, r.headers.get('cache-control'), m.relever.mock.calls[0][1]]).toEqual([200, 'no-store', 'crm']);
    expect((await route.GET(req())).status).toBe(400);
    expect((await route.GET(req('?app=cms'))).status).toBe(400);
  });

  it('lecture seule : la route n\'a qu\'un GET', () => {
    expect(Object.keys(route).filter((k) => /^(POST|PUT|PATCH|DELETE)$/.test(k))).toEqual([]);
  });
});
