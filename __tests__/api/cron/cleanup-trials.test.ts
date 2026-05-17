/**
 * Test smoke pour POST /api/cron/cleanup-trials après removal Twenty (2026-05-18).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/tenants/cleanup', () => ({
  cleanupExpiredTrials: vi.fn(async () => ({
    success: true,
    tenantsProcessed: 0,
    tenantsDeleted: 0,
    errors: [],
  })),
  getExpiringTrials: vi.fn(async () => []),
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'test-secret';
});

function makeReq(authHeader: string | null) {
  return {
    headers: {
      get: (k: string) => (k.toLowerCase() === 'authorization' ? authHeader : null),
    },
  } as any;
}

describe('cron/cleanup-trials', () => {
  it('GET returns metadata with no twenty reference', async () => {
    const { GET } = await import('@/app/api/cron/cleanup-trials/route');
    const res = await GET();
    const body = await res.json();
    expect(body.endpoint).toBe('/api/cron/cleanup-trials');
    expect(JSON.stringify(body)).not.toMatch(/twenty/i);
  });

  it('POST rejects missing auth header', async () => {
    const { POST } = await import('@/app/api/cron/cleanup-trials/route');
    const res = await POST(makeReq(null));
    expect(res.status).toBe(401);
  });

  it('POST accepts valid CRON_SECRET', async () => {
    const { POST } = await import('@/app/api/cron/cleanup-trials/route');
    const res = await POST(makeReq('Bearer test-secret'));
    expect(res.status).toBe(200);
  });
});
