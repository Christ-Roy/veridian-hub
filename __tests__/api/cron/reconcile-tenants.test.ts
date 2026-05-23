/**
 * Tests du route handler POST /api/cron/reconcile-tenants.
 *
 * Mirror du pattern de `__tests__/api/cron/trial-tick.test.ts` : on mock
 * `runReconcile` et on vérifie le thin wrapper (auth Bearer + dispatch +
 * relais summary + 500 + Telegram).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const runReconcileMock = vi.fn();
const sendTelegramAlertMock = vi.fn();

vi.mock('@/lib/sync/reconcile', () => ({
  runReconcile: (...args: unknown[]) => runReconcileMock(...args),
}));

vi.mock('@/lib/notifications/telegram', () => ({
  sendTelegramAlert: (...args: unknown[]) => sendTelegramAlertMock(...args),
}));

const ORIGINAL_SECRET = process.env.CRON_SECRET;
const ORIGINAL_THRESHOLD = process.env.RECONCILE_ALERT_THRESHOLD;

beforeEach(() => {
  runReconcileMock.mockReset();
  sendTelegramAlertMock.mockReset();
  // Par défaut le mock Telegram résout (la route appelle `.catch()` dessus).
  sendTelegramAlertMock.mockResolvedValue(true);
  process.env.CRON_SECRET = 'test-cron-secret-xyz';
  delete process.env.RECONCILE_ALERT_THRESHOLD;
  vi.resetModules();
});

function makeRequest(auth: string | null, qs = ''): Request {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.authorization = auth;
  return new Request(`http://x/api/cron/reconcile-tenants${qs}`, {
    method: 'POST',
    headers,
  });
}

describe('POST /api/cron/reconcile-tenants — route wrapper', () => {
  it('returns 500 if CRON_SECRET env missing', async () => {
    delete process.env.CRON_SECRET;
    const { POST } = await import('@/app/api/cron/reconcile-tenants/route');
    const res = await POST(makeRequest('Bearer anything') as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('cron_not_configured');
    expect(runReconcileMock).not.toHaveBeenCalled();
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  it('returns 401 if wrong secret', async () => {
    const { POST } = await import('@/app/api/cron/reconcile-tenants/route');
    const res = await POST(makeRequest('Bearer wrong') as never);
    expect(res.status).toBe(401);
    expect(runReconcileMock).not.toHaveBeenCalled();
  });

  it('returns 401 if no Authorization header', async () => {
    const { POST } = await import('@/app/api/cron/reconcile-tenants/route');
    const res = await POST(makeRequest(null) as never);
    expect(res.status).toBe(401);
  });

  it('calls runReconcile and relays summary when secret OK', async () => {
    runReconcileMock.mockResolvedValueOnce({
      usersScanned: 10,
      appsQueried: 40,
      driftsDetected: 2,
      drifts: [
        { hubTenantId: 't1', app: 'notifuse', kind: 'plan_mismatch' },
        { hubTenantId: 't2', app: 'prospection', kind: 'status_mismatch' },
      ],
      appsUnreachable: 0,
      startedAt: '2026-05-23T10:00:00Z',
      durationMs: 1234,
      mode: 'dry-run',
      errors: [],
    });
    const { POST } = await import('@/app/api/cron/reconcile-tenants/route');
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(200);
    expect(runReconcileMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        usersScanned: 10,
        driftsDetected: 2,
        mode: 'dry-run',
      }),
    );
  });

  it('parses limit and apps from querystring and passes to runReconcile', async () => {
    runReconcileMock.mockResolvedValueOnce({
      usersScanned: 0,
      appsQueried: 0,
      driftsDetected: 0,
      drifts: [],
      appsUnreachable: 0,
      startedAt: 'now',
      durationMs: 1,
      mode: 'dry-run',
      errors: [],
    });
    const { POST } = await import('@/app/api/cron/reconcile-tenants/route');
    await POST(
      makeRequest(
        'Bearer test-cron-secret-xyz',
        '?limit=42&apps=notifuse,prospection',
      ) as never,
    );
    expect(runReconcileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 42,
        apps: ['notifuse', 'prospection'],
      }),
    );
  });

  it('clamps limit to [1, 500] and rejects garbage values', async () => {
    runReconcileMock.mockResolvedValue({
      usersScanned: 0,
      appsQueried: 0,
      driftsDetected: 0,
      drifts: [],
      appsUnreachable: 0,
      startedAt: 'now',
      durationMs: 1,
      mode: 'dry-run',
      errors: [],
    });
    const { POST } = await import('@/app/api/cron/reconcile-tenants/route');

    await POST(
      makeRequest('Bearer test-cron-secret-xyz', '?limit=99999') as never,
    );
    expect(runReconcileMock.mock.calls[0][0]).toMatchObject({ limit: 500 });

    runReconcileMock.mockClear();
    await POST(
      makeRequest('Bearer test-cron-secret-xyz', '?limit=garbage') as never,
    );
    expect(runReconcileMock.mock.calls[0][0]).toMatchObject({ limit: 100 });
  });

  it('alerts Telegram when drifts >= threshold', async () => {
    process.env.RECONCILE_ALERT_THRESHOLD = '3';
    runReconcileMock.mockResolvedValueOnce({
      usersScanned: 100,
      appsQueried: 400,
      driftsDetected: 5,
      drifts: [],
      appsUnreachable: 0,
      startedAt: 'now',
      durationMs: 1,
      mode: 'dry-run',
      errors: [],
    });
    const { POST } = await import('@/app/api/cron/reconcile-tenants/route');
    await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(sendTelegramAlertMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramAlertMock.mock.calls[0][0]).toMatch(/drift/);
  });

  it('does not alert when drifts < threshold', async () => {
    process.env.RECONCILE_ALERT_THRESHOLD = '10';
    runReconcileMock.mockResolvedValueOnce({
      usersScanned: 100,
      appsQueried: 400,
      driftsDetected: 2,
      drifts: [],
      appsUnreachable: 0,
      startedAt: 'now',
      durationMs: 1,
      mode: 'dry-run',
      errors: [],
    });
    const { POST } = await import('@/app/api/cron/reconcile-tenants/route');
    await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(sendTelegramAlertMock).not.toHaveBeenCalled();
  });

  it('returns 500 + Telegram alert when runReconcile throws', async () => {
    runReconcileMock.mockRejectedValueOnce(new Error('boom reconcile'));
    sendTelegramAlertMock.mockResolvedValueOnce(true);
    const { POST } = await import('@/app/api/cron/reconcile-tenants/route');
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/boom reconcile/);
    expect(sendTelegramAlertMock).toHaveBeenCalled();
    expect(sendTelegramAlertMock.mock.calls[0][0]).toMatch(
      /Cron reconcile-tenants KO/,
    );
  });
});

describe('GET /api/cron/reconcile-tenants — observabilité', () => {
  it('returns 200 with endpoint description (no auth required)', async () => {
    const { GET } = await import('@/app/api/cron/reconcile-tenants/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoint).toBe('/api/cron/reconcile-tenants');
    expect(body.method).toBe('POST');
  });
});

afterAll(() => {
  if (ORIGINAL_THRESHOLD === undefined) {
    delete process.env.RECONCILE_ALERT_THRESHOLD;
  } else {
    process.env.RECONCILE_ALERT_THRESHOLD = ORIGINAL_THRESHOLD;
  }
});
