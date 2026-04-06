import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
