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

  it('reports the built commit SHA when the image carries it', async () => {
    const before = process.env.HUB_GIT_SHA;
    process.env.HUB_GIT_SHA = '0b74d0a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7';
    try {
      const response = await GET();
      expect(response.body).toMatchObject({ version: '0b74d0a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7' });
      process.env.HUB_GIT_SHA = 'pas-un-sha';
      expect((await GET()).body).toMatchObject({ version: 'unknown' });
    } finally {
      if (before === undefined) delete process.env.HUB_GIT_SHA;
      else process.env.HUB_GIT_SHA = before;
    }
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
