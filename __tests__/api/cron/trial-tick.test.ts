/**
 * Tests du route handler POST /api/cron/trial-tick.
 *
 * Ce fichier ne teste QUE le thin wrapper (auth Bearer + dispatch vers
 * `runTrialTick`). La logique de la state machine elle-même est testée
 * dans `__tests__/lib/trial/run-tick.test.ts`.
 *
 * On mock `runTrialTick` pour vérifier que la route :
 *   - rejette si CRON_SECRET absent (500) ou mauvais (401)
 *   - appelle `runTrialTick` une fois sur succès auth
 *   - relaie le summary dans le JSON de réponse
 *   - retourne 500 + alerte Telegram si runTrialTick throw
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runTrialTickMock = vi.fn();
const sendTelegramAlertMock = vi.fn();

vi.mock('@/lib/trial/run-tick', () => ({
  runTrialTick: (...args: unknown[]) => runTrialTickMock(...args),
}));

vi.mock('@/lib/notifications/telegram', () => ({
  sendTelegramAlert: (...args: unknown[]) => sendTelegramAlertMock(...args),
}));

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  runTrialTickMock.mockReset();
  sendTelegramAlertMock.mockReset();
  process.env.CRON_SECRET = 'test-cron-secret-xyz';
  vi.resetModules();
});

function makeRequest(auth: string | null) {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.authorization = auth;
  return new Request('http://x/api/cron/trial-tick', {
    method: 'POST',
    headers,
  });
}

describe('POST /api/cron/trial-tick — route wrapper', () => {
  it('returns 500 if CRON_SECRET env missing', async () => {
    delete process.env.CRON_SECRET;
    const { POST } = await import('@/app/api/cron/trial-tick/route');
    const res = await POST(makeRequest('Bearer anything') as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('cron_not_configured');
    expect(runTrialTickMock).not.toHaveBeenCalled();
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  it('returns 401 if wrong secret', async () => {
    const { POST } = await import('@/app/api/cron/trial-tick/route');
    const res = await POST(makeRequest('Bearer wrong') as never);
    expect(res.status).toBe(401);
    expect(runTrialTickMock).not.toHaveBeenCalled();
  });

  it('returns 401 if no Authorization header', async () => {
    const { POST } = await import('@/app/api/cron/trial-tick/route');
    const res = await POST(makeRequest(null) as never);
    expect(res.status).toBe(401);
  });

  it('calls runTrialTick and returns its summary in 200 response when secret OK', async () => {
    runTrialTickMock.mockResolvedValueOnce({
      activated: 2,
      notified: 1,
      expired: 0,
      converted: 1,
      errors: [],
    });

    const { POST } = await import('@/app/api/cron/trial-tick/route');
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(200);
    expect(runTrialTickMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        activated: 2,
        notified: 1,
        converted: 1,
      }),
    );
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 500 + Telegram alert when runTrialTick throws', async () => {
    runTrialTickMock.mockRejectedValueOnce(new Error('boom downstream'));
    sendTelegramAlertMock.mockResolvedValueOnce(true);

    const { POST } = await import('@/app/api/cron/trial-tick/route');
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/boom downstream/);
    expect(sendTelegramAlertMock).toHaveBeenCalled();
    expect(sendTelegramAlertMock.mock.calls[0][0]).toMatch(/Cron trial-tick KO/);
  });
});

describe('GET /api/cron/trial-tick — observabilité', () => {
  it('returns 200 with endpoint description (no auth required)', async () => {
    const { GET } = await import('@/app/api/cron/trial-tick/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoint).toBe('/api/cron/trial-tick');
    expect(body.method).toBe('POST');
  });
});
