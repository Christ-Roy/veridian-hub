/**
 * Test smoke pour GET /api/tenants/status après removal Twenty (2026-05-18).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/get-user', () => ({
  requireUser: vi.fn(async () => ({
    id: 'u1',
    email: 'a@test',
    supabaseUserId: 'uuid-1',
  })),
  userUuid: (u: any) => u.supabaseUserId,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(async () => ({
        id: 't1',
        name: 'Test',
        status: 'active',
        notifuseWorkspaceSlug: 'ws',
        provisioningLogs: [],
      })),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/tenants/status', () => {
  it('returns notifuse block, no twenty', async () => {
    const { GET } = await import('@/app/api/tenants/status/route');
    const res = await GET();
    const body = await res.json();
    expect(body).toHaveProperty('notifuse');
    expect(body).not.toHaveProperty('twenty');
    expect(body.notifuse.configured).toBe(true);
  });
});
