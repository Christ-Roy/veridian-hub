/**
 * Tests du route handler POST /api/cron/trial-drift-detection.
 *
 * Mirror du pattern de `__tests__/api/cron/reconcile-tenants.test.ts` : on
 * mock `detectTrialSubDrifts` et on vérifie le thin wrapper :
 *   - auth Bearer (500 si secret env manquant, 401 si mauvais secret)
 *   - dispatch avec chunkSize/limit clampés depuis querystring
 *   - shape body retour (ok + summary + drifts)
 *   - mode report-only relayé tel quel (no auto-fix exposé)
 *   - GET endpoint d'observabilité sans auth
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const detectTrialSubDriftsMock = vi.fn();

vi.mock('@/lib/trial/drift-detection', () => ({
  detectTrialSubDrifts: (...args: unknown[]) =>
    detectTrialSubDriftsMock(...args),
}));

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  detectTrialSubDriftsMock.mockReset();
  process.env.CRON_SECRET = 'test-cron-secret-xyz';
  vi.resetModules();
});

function makeRequest(auth: string | null, qs = ''): Request {
  const headers: Record<string, string> = {};
  if (auth !== null) headers.authorization = auth;
  return new Request(`http://x/api/cron/trial-drift-detection${qs}`, {
    method: 'POST',
    headers,
  });
}

function defaultSummary(over: Partial<Record<string, unknown>> = {}) {
  return {
    totalScanned: 0,
    skippedNoStripeCustomer: 0,
    stripeErrors: 0,
    driftsDetected: 0,
    drifts: [],
    startedAt: '2026-05-25T07:00:00Z',
    durationMs: 1,
    mode: 'report-only',
    errors: [],
    ...over,
  };
}

describe('POST /api/cron/trial-drift-detection — route wrapper', () => {
  it('returns 500 if CRON_SECRET env missing', async () => {
    delete process.env.CRON_SECRET;
    const { POST } = await import(
      '@/app/api/cron/trial-drift-detection/route'
    );
    const res = await POST(makeRequest('Bearer anything') as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('cron_not_configured');
    expect(detectTrialSubDriftsMock).not.toHaveBeenCalled();
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  it('returns 401 if wrong secret', async () => {
    const { POST } = await import(
      '@/app/api/cron/trial-drift-detection/route'
    );
    const res = await POST(makeRequest('Bearer wrong') as never);
    expect(res.status).toBe(401);
    expect(detectTrialSubDriftsMock).not.toHaveBeenCalled();
  });

  it('returns 401 if no Authorization header', async () => {
    const { POST } = await import(
      '@/app/api/cron/trial-drift-detection/route'
    );
    const res = await POST(makeRequest(null) as never);
    expect(res.status).toBe(401);
  });

  it('calls detectTrialSubDrifts with defaults and returns report-only summary', async () => {
    detectTrialSubDriftsMock.mockResolvedValueOnce(
      defaultSummary({
        totalScanned: 12,
        driftsDetected: 2,
        drifts: [
          {
            tenantId: 't1',
            app: 'notifuse',
            userId: 'u1',
            stripeCustomerId: 'cus_1',
            trialState: 'trial_active',
            stripeStatus: 'active',
            severity: 'medium',
            observedAt: '2026-05-25T07:00:00Z',
          },
        ],
      }),
    );
    const { POST } = await import(
      '@/app/api/cron/trial-drift-detection/route'
    );
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(200);
    expect(detectTrialSubDriftsMock).toHaveBeenCalledTimes(1);
    // chunkSize défaut = 100, pas de limit
    expect(detectTrialSubDriftsMock).toHaveBeenCalledWith(
      expect.objectContaining({ chunkSize: 100 }),
    );
    expect(detectTrialSubDriftsMock.mock.calls[0][0].limit).toBeUndefined();

    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      summary: expect.objectContaining({
        totalScanned: 12,
        driftsDetected: 2,
        mode: 'report-only',
      }),
      drifts: expect.arrayContaining([
        expect.objectContaining({ tenantId: 't1', severity: 'medium' }),
      ]),
    });
  });

  it('clamps chunkSize from querystring (garbage → 100, > 500 → 500)', async () => {
    detectTrialSubDriftsMock.mockResolvedValue(defaultSummary());
    const { POST } = await import(
      '@/app/api/cron/trial-drift-detection/route'
    );

    await POST(
      makeRequest('Bearer test-cron-secret-xyz', '?chunkSize=99999') as never,
    );
    expect(detectTrialSubDriftsMock.mock.calls[0][0]).toMatchObject({
      chunkSize: 500,
    });

    detectTrialSubDriftsMock.mockClear();
    await POST(
      makeRequest('Bearer test-cron-secret-xyz', '?chunkSize=garbage') as never,
    );
    expect(detectTrialSubDriftsMock.mock.calls[0][0]).toMatchObject({
      chunkSize: 100,
    });

    detectTrialSubDriftsMock.mockClear();
    await POST(
      makeRequest('Bearer test-cron-secret-xyz', '?chunkSize=42') as never,
    );
    expect(detectTrialSubDriftsMock.mock.calls[0][0]).toMatchObject({
      chunkSize: 42,
    });
  });

  it('passes limit when valid, omits otherwise', async () => {
    detectTrialSubDriftsMock.mockResolvedValue(defaultSummary());
    const { POST } = await import(
      '@/app/api/cron/trial-drift-detection/route'
    );

    await POST(
      makeRequest('Bearer test-cron-secret-xyz', '?limit=500') as never,
    );
    expect(detectTrialSubDriftsMock.mock.calls[0][0]).toMatchObject({
      limit: 500,
    });

    detectTrialSubDriftsMock.mockClear();
    await POST(
      makeRequest('Bearer test-cron-secret-xyz', '?limit=garbage') as never,
    );
    expect(detectTrialSubDriftsMock.mock.calls[0][0].limit).toBeUndefined();
  });

  it('returns 500 with structured error when detectTrialSubDrifts throws', async () => {
    detectTrialSubDriftsMock.mockRejectedValueOnce(new Error('boom drift'));
    const { POST } = await import(
      '@/app/api/cron/trial-drift-detection/route'
    );
    const res = await POST(makeRequest('Bearer test-cron-secret-xyz') as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      error: expect.stringContaining('boom drift'),
    });
  });
});

describe('GET /api/cron/trial-drift-detection — observabilité', () => {
  it('returns 200 with endpoint description (no auth required)', async () => {
    const { GET } = await import(
      '@/app/api/cron/trial-drift-detection/route'
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoint).toBe('/api/cron/trial-drift-detection');
    expect(body.method).toBe('POST');
    expect(body.description).toMatch(/report-only/i);
  });
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  }
});
