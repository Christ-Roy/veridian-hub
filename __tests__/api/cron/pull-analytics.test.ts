/**
 * Tests du route handler POST /api/cron/pull-analytics.
 *
 * Mirror du pattern de `__tests__/api/cron/reconcile-tenants.test.ts` : on mock
 * `pullAnalytics` et on vérifie le thin wrapper (auth Bearer + dispatch +
 * relais summary + 500 + Telegram + GET observabilité).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const pullAnalyticsMock = vi.fn();
const pullDepsFromEnvMock = vi.fn();
const sendTelegramAlertMock = vi.fn();

vi.mock('@/lib/prospect/analytics-pull', () => ({
  pullAnalytics: (...args: unknown[]) => pullAnalyticsMock(...args),
  pullDepsFromEnv: (...args: unknown[]) => pullDepsFromEnvMock(...args)
}));

vi.mock('@/lib/notifications/telegram', () => ({
  sendTelegramAlert: (...args: unknown[]) => sendTelegramAlertMock(...args)
}));

const ORIGINAL_SECRET = process.env.CRON_SECRET;

const SUMMARY = {
  pulled: 12,
  identities: 3,
  emitted: 7,
  ingested: 7,
  attributable: 2,
  skipped: false,
  since: '2026-06-15T12:00:00.000Z',
  until: '2026-06-17T12:00:00.000Z',
  durationMs: 42
};

beforeEach(() => {
  pullAnalyticsMock.mockReset();
  pullDepsFromEnvMock.mockReset();
  sendTelegramAlertMock.mockReset();
  sendTelegramAlertMock.mockResolvedValue(true);
  pullDepsFromEnvMock.mockReturnValue({ engine: {}, workspaceSlug: 'ws' });
  process.env.CRON_SECRET = 'test-cron-secret-xyz';
  vi.resetModules();
});

function makeRequest(auth: string | null): Request {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.authorization = auth;
  return new Request('http://x/api/cron/pull-analytics', {
    method: 'POST',
    headers
  });
}

describe('POST /api/cron/pull-analytics — route wrapper', () => {
  it('returns 500 if CRON_SECRET env missing', async () => {
    delete process.env.CRON_SECRET;
    const { POST } = await import('@/app/api/cron/pull-analytics/route');
    const res = await POST(makeRequest('Bearer anything') as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('cron_not_configured');
    expect(pullAnalyticsMock).not.toHaveBeenCalled();
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  it('returns 401 if wrong secret', async () => {
    const { POST } = await import('@/app/api/cron/pull-analytics/route');
    const res = await POST(makeRequest('Bearer wrong') as never);
    expect(res.status).toBe(401);
    expect(pullAnalyticsMock).not.toHaveBeenCalled();
  });

  it('returns 401 if no Authorization header', async () => {
    const { POST } = await import('@/app/api/cron/pull-analytics/route');
    const res = await POST(makeRequest(null) as never);
    expect(res.status).toBe(401);
  });

  it('calls pullAnalytics and relays summary when secret OK', async () => {
    pullAnalyticsMock.mockResolvedValueOnce(SUMMARY);
    const { POST } = await import('@/app/api/cron/pull-analytics/route');
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(200);
    expect(pullAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(pullDepsFromEnvMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        pulled: 12,
        emitted: 7,
        attributable: 2,
        skipped: false
      })
    );
    expect(typeof body.httpDurationMs).toBe('number');
  });

  it('relays skipped summary (missing engine creds) as 200', async () => {
    pullAnalyticsMock.mockResolvedValueOnce({
      ...SUMMARY,
      skipped: true,
      emitted: 0
    });
    const { POST } = await import('@/app/api/cron/pull-analytics/route');
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(sendTelegramAlertMock).not.toHaveBeenCalled();
  });

  it('returns 500 + Telegram alert when pullAnalytics throws', async () => {
    pullAnalyticsMock.mockRejectedValueOnce(new Error('boom pull'));
    const { POST } = await import('@/app/api/cron/pull-analytics/route');
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/boom pull/);
    expect(sendTelegramAlertMock).toHaveBeenCalled();
    expect(sendTelegramAlertMock.mock.calls[0][0]).toMatch(/pull-analytics KO/);
  });
});

describe('GET /api/cron/pull-analytics — observabilité', () => {
  it('returns 200 with endpoint description (no auth required)', async () => {
    const { GET } = await import('@/app/api/cron/pull-analytics/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoint).toBe('/api/cron/pull-analytics');
    expect(body.method).toBe('POST');
  });
});
