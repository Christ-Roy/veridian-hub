/**
 * Tests du route handler POST /api/cron/push-prospect-scores.
 *
 * Mirror du pattern de `__tests__/api/cron/pull-analytics.test.ts` : on mock
 * `pushProspectScores` + `pushDepsFromEnv` et on vérifie le thin wrapper (auth
 * Bearer + dispatch + relais summary + 500 + Telegram + GET observabilité).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushProspectScoresMock = vi.fn();
const pushDepsFromEnvMock = vi.fn();
const sendTelegramAlertMock = vi.fn();

vi.mock('@/lib/prospect/push-to-crm', () => ({
  pushProspectScores: (...args: unknown[]) => pushProspectScoresMock(...args),
  pushDepsFromEnv: (...args: unknown[]) => pushDepsFromEnvMock(...args),
}));

vi.mock('@/lib/notifications/telegram', () => ({
  sendTelegramAlert: (...args: unknown[]) => sendTelegramAlertMock(...args),
}));

const ORIGINAL_SECRET = process.env.CRON_SECRET;

const SUMMARY = {
  candidates: 3,
  scored: 3,
  pushed: 2,
  unchanged: 1,
  noCrmTenant: 0,
  personNotFound: 0,
  errors: 0,
  dryRun: true,
  engineId: 'tunnel-v2',
  durationMs: 42,
};

beforeEach(() => {
  pushProspectScoresMock.mockReset();
  pushDepsFromEnvMock.mockReset();
  sendTelegramAlertMock.mockReset();
  sendTelegramAlertMock.mockResolvedValue(true);
  pushDepsFromEnvMock.mockReturnValue({ dryRun: true, engineId: 'tunnel-v2' });
  process.env.CRON_SECRET = 'test-cron-secret-xyz';
  vi.resetModules();
});

function makeRequest(auth: string | null, search = ''): Request {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.authorization = auth;
  return new Request(`http://x/api/cron/push-prospect-scores${search}`, {
    method: 'POST',
    headers,
  });
}

describe('POST /api/cron/push-prospect-scores — route wrapper', () => {
  it('returns 500 if CRON_SECRET env missing', async () => {
    delete process.env.CRON_SECRET;
    const { POST } = await import('@/app/api/cron/push-prospect-scores/route');
    const res = await POST(makeRequest('Bearer anything') as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('cron_not_configured');
    expect(pushProspectScoresMock).not.toHaveBeenCalled();
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  it('returns 401 if wrong secret', async () => {
    const { POST } = await import('@/app/api/cron/push-prospect-scores/route');
    const res = await POST(makeRequest('Bearer wrong') as never);
    expect(res.status).toBe(401);
    expect(pushProspectScoresMock).not.toHaveBeenCalled();
  });

  it('returns 401 if no Authorization header', async () => {
    const { POST } = await import('@/app/api/cron/push-prospect-scores/route');
    const res = await POST(makeRequest(null) as never);
    expect(res.status).toBe(401);
  });

  it('calls pushProspectScores and relays summary when secret OK', async () => {
    pushProspectScoresMock.mockResolvedValueOnce(SUMMARY);
    const { POST } = await import('@/app/api/cron/push-prospect-scores/route');
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(200);
    expect(pushProspectScoresMock).toHaveBeenCalledTimes(1);
    expect(pushDepsFromEnvMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        scored: 3,
        pushed: 2,
        unchanged: 1,
        dryRun: true,
      }),
    );
    expect(typeof body.httpDurationMs).toBe('number');
  });

  it('forwards limit querystring to pushProspectScores', async () => {
    pushProspectScoresMock.mockResolvedValueOnce(SUMMARY);
    const { POST } = await import('@/app/api/cron/push-prospect-scores/route');
    await POST(makeRequest('Bearer test-cron-secret-xyz', '?limit=50') as never);
    const call = pushProspectScoresMock.mock.calls[0][0];
    expect(call.limit).toBe(50);
  });

  it('returns 500 + Telegram alert when pushProspectScores throws', async () => {
    pushProspectScoresMock.mockRejectedValueOnce(new Error('boom push'));
    const { POST } = await import('@/app/api/cron/push-prospect-scores/route');
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/boom push/);
    expect(sendTelegramAlertMock).toHaveBeenCalled();
    expect(sendTelegramAlertMock.mock.calls[0][0]).toMatch(/push-prospect-scores KO/);
  });
});

describe('GET /api/cron/push-prospect-scores — observabilité', () => {
  it('returns 200 with endpoint description (no auth required)', async () => {
    const { GET } = await import('@/app/api/cron/push-prospect-scores/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoint).toBe('/api/cron/push-prospect-scores');
    expect(body.method).toBe('POST');
  });
});
