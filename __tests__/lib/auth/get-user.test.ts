/**
 * Test smoke pour lib/auth/get-user après removal Twenty (commentaire updated 2026-05-18).
 *
 * Couvre les helpers : getCurrentUser, requireUser, userUuid.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authMock = vi.fn();
vi.mock('@/auth', () => ({
  auth: () => authMock(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        id: 'u1',
        email: 'a@test',
        name: null,
        image: null,
        supabaseUserId: 'uuid-1',
      })),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('lib/auth/get-user', () => {
  it('getCurrentUser returns null when no session', async () => {
    authMock.mockResolvedValueOnce(null);
    const { getCurrentUser } = await import('@/lib/auth/get-user');
    expect(await getCurrentUser()).toBeNull();
  });

  it('getCurrentUser returns user when session present', async () => {
    authMock.mockResolvedValueOnce({ user: { id: 'u1' } });
    const { getCurrentUser } = await import('@/lib/auth/get-user');
    const u = await getCurrentUser();
    expect(u?.email).toBe('a@test');
    expect(u?.supabaseUserId).toBe('uuid-1');
  });

  it('requireUser throws 401 Response when no session', async () => {
    authMock.mockResolvedValueOnce(null);
    const { requireUser } = await import('@/lib/auth/get-user');
    await expect(requireUser()).rejects.toBeInstanceOf(Response);
  });

  it('userUuid returns supabaseUserId', async () => {
    const { userUuid } = await import('@/lib/auth/get-user');
    expect(userUuid({ id: 'u1', email: 'a@test', name: null, image: null, supabaseUserId: 'uuid-1' })).toBe('uuid-1');
  });

  it('userUuid throws if supabaseUserId is null', async () => {
    const { userUuid } = await import('@/lib/auth/get-user');
    expect(() => userUuid({ id: 'u1', email: 'a@test', name: null, image: null, supabaseUserId: null })).toThrow();
  });
});
