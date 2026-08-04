import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryRawMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
  },
}));

// Mock NextResponse before importing the route
vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    })),
  },
}));

import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    queryRawMock.mockResolvedValue([{ ok: 1 }]);
  });

  it('returns status ok', async () => {
    const response = await GET();
    expect(response.body).toHaveProperty('status', 'ok');
  });

  it('returns service name web-dashboard', async () => {
    const response = await GET();
    expect(response.body).toHaveProperty('service', 'web-dashboard');
  });

  it('returns a valid ISO timestamp', async () => {
    const response = await GET();
    const ts = (response.body as { timestamp: string }).timestamp;
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it('returns HTTP 200', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it('reports the database status', async () => {
    const response = await GET();
    expect(response.body).toMatchObject({
      status: 'ok',
      version: 'unknown',
      db: 'ok',
      dependencies: {},
    });
  });

  it('returns HTTP 503 without leaking details when the database is unavailable', async () => {
    queryRawMock.mockRejectedValueOnce(new Error('secret database hostname'));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'down', db: 'ko' });
    expect(JSON.stringify(response.body)).not.toContain('secret database hostname');
  });

  it('returns HTTP 503 when the database check times out', async () => {
    vi.useFakeTimers();
    queryRawMock.mockReturnValueOnce(new Promise(() => undefined));

    const responsePromise = GET();
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'down', db: 'ko' });
  });
});
