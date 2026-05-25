/**
 * Tests GET /api/admin/mail-rate-limit/stats.
 *
 * Couvre :
 *  - 401 si pas de x-admin-secret + pas de session
 *  - 200 retourne window_minutes + total_events_24h + top_recipients + top_senders
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const ADMIN_SECRET = 'admin-stats-secret-for-mail-rate-limit';

const eventCountMock = vi.fn();
const eventGroupByMock = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    mailRateLimitEvent: {
      count: (...args: unknown[]) => eventCountMock(...args),
      groupBy: (...args: unknown[]) => eventGroupByMock(...args),
    },
  },
}));

vi.mock('@/auth', () => ({
  auth: vi.fn().mockResolvedValue(null), // pas de session par défaut
}));

vi.mock('@/lib/admin/check-admin', () => ({
  isPlatformAdmin: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/auth/impersonation', () => ({
  isImpersonatedSession: vi.fn().mockReturnValue(false),
}));

import { adminApiLimiter } from '@/lib/auth/rate-limit';

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `10.0.3.${ipCounter}`;
}

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  adminApiLimiter.reset();
  eventCountMock.mockReset();
  eventGroupByMock.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function callRoute(req: Request): Promise<Response> {
  const route = await import('@/app/api/admin/mail-rate-limit/stats/route');
  return route.GET(req as any);
}

describe('GET /api/admin/mail-rate-limit/stats', () => {
  it('returns 401 without admin secret + no session', async () => {
    const req = new Request('http://localhost/api/admin/mail-rate-limit/stats', {
      headers: { 'x-forwarded-for': freshIp() },
    });
    const res = await callRoute(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 with stats when admin secret valid', async () => {
    eventCountMock.mockResolvedValueOnce(42);
    eventGroupByMock
      .mockResolvedValueOnce([
        { recipientEmail: 'spammed@x.com', _count: { _all: 10 } },
        { recipientEmail: 'often@y.com', _count: { _all: 5 } },
      ])
      .mockResolvedValueOnce([
        { senderUserId: 'cuid_alice', _count: { _all: 8 } },
      ]);
    const req = new Request('http://localhost/api/admin/mail-rate-limit/stats', {
      headers: {
        'x-admin-secret': ADMIN_SECRET,
        'x-forwarded-for': freshIp(),
      },
    });
    const res = await callRoute(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.window_minutes).toBe(20);
    expect(json.total_events_24h).toBe(42);
    expect(json.top_recipients_blocked).toEqual([
      { email: 'spammed@x.com', count: 10 },
      { email: 'often@y.com', count: 5 },
    ]);
    expect(json.top_senders).toEqual([
      { user_id: 'cuid_alice', count: 8 },
    ]);
  });

  it('has Cache-Control no-store', async () => {
    eventCountMock.mockResolvedValueOnce(0);
    eventGroupByMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const req = new Request('http://localhost/api/admin/mail-rate-limit/stats', {
      headers: {
        'x-admin-secret': ADMIN_SECRET,
        'x-forwarded-for': freshIp(),
      },
    });
    const res = await callRoute(req);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects bad secret', async () => {
    const req = new Request('http://localhost/api/admin/mail-rate-limit/stats', {
      headers: {
        'x-admin-secret': 'wrong-secret-same-length-as-real-one',
        'x-forwarded-for': freshIp(),
      },
    });
    const res = await callRoute(req);
    expect(res.status).toBe(401);
  });
});
