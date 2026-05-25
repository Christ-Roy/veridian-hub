/**
 * Tests /api/gmail/disconnect.
 *
 * Couvre :
 *   - 401 si pas de session
 *   - 200 idempotent quand aucun Account Gmail linké
 *   - clear refresh + reset needs_reauth quand Account présent
 *   - revoke Google appelé (best-effort)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sessionUser = {
  id: 'cuid_user',
  email: 'alice@example.com',
  name: null,
  image: null,
  supabaseUserId: null,
};
const getCurrentUserMock = vi.fn();
vi.mock('@/lib/auth/get-user', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));

const findFirstMock = vi.fn();
const updateMock = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    account: {
      findFirst: (...args: unknown[]) => findFirstMock(...(args as [unknown])),
      update: (...args: unknown[]) => updateMock(...(args as [unknown])),
    },
  },
}));

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  getCurrentUserMock.mockReset();
  findFirstMock.mockReset();
  updateMock.mockReset();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function callRoute() {
  const route = await import('@/app/api/gmail/disconnect/route');
  return route.POST();
}

describe('POST /api/gmail/disconnect', () => {
  it('returns 401 without session', async () => {
    getCurrentUserMock.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(401);
  });

  it('returns 200 (no-op) when no Gmail account linked', async () => {
    getCurrentUserMock.mockResolvedValueOnce(sessionUser);
    findFirstMock.mockResolvedValueOnce(null);
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('revokes token and clears fields when account exists', async () => {
    getCurrentUserMock.mockResolvedValueOnce(sessionUser);
    findFirstMock.mockResolvedValueOnce({ id: 'acc_1', refresh_token: 'r-tok' });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    updateMock.mockResolvedValueOnce({});

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain('oauth2.googleapis.com/revoke');
    expect(fetchMock.mock.calls[0][0]).toContain('r-tok');

    const updateArgs = updateMock.mock.calls[0][0];
    expect(updateArgs.where.id).toBe('acc_1');
    expect(updateArgs.data.refresh_token).toBeNull();
    expect(updateArgs.data.access_token).toBeNull();
    expect(updateArgs.data.mailSendScope).toBeNull();
    expect(updateArgs.data.mailSendNeedsReauth).toBe(false);
  });

  it('still clears DB even if Google revoke fetch fails', async () => {
    getCurrentUserMock.mockResolvedValueOnce(sessionUser);
    findFirstMock.mockResolvedValueOnce({ id: 'acc_1', refresh_token: 'r' });
    fetchMock.mockRejectedValueOnce(new Error('network'));
    updateMock.mockResolvedValueOnce({});

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledOnce();
  });
});
