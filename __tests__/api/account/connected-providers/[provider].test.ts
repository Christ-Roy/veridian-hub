/**
 * Tests pour DELETE /api/account/connected-providers/[provider]
 *
 * Couvre :
 *  - unsupported_provider (credentials et provider inconnu)
 *  - 404 si provider OAuth pas connecté
 *  - 409 anti-lockout si dernier provider
 *  - Happy paths : Google supprimé quand MS+creds restent, MS supprimé quand G reste
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('@/lib/auth/get-user', () => ({
  requireUser: vi.fn(async () => ({
    id: 'u1',
    email: 'alice@example.com',
    supabaseUserId: 'uuid-u1',
  })),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    account: {
      findMany: (...args: unknown[]) => findManyMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const makeReq = () => new Request('http://x/test', { method: 'DELETE' });

describe('DELETE /api/account/connected-providers/[provider]', () => {
  it('refuse le provider unsupported "credentials"', async () => {
    const { DELETE } = await import('@/app/api/account/connected-providers/[provider]/route');
    const res = await DELETE(makeReq(), { params: Promise.resolve({ provider: 'credentials' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unsupported_provider');
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('refuse le provider unsupported "github" (pas dans whitelist)', async () => {
    const { DELETE } = await import('@/app/api/account/connected-providers/[provider]/route');
    const res = await DELETE(makeReq(), { params: Promise.resolve({ provider: 'github' }) });
    expect(res.status).toBe(400);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('retourne 404 si provider OAuth pas connecté au user', async () => {
    findManyMock.mockResolvedValueOnce([
      { id: 'a1', provider: 'credentials' },
    ]);
    const { DELETE } = await import('@/app/api/account/connected-providers/[provider]/route');
    const res = await DELETE(makeReq(), { params: Promise.resolve({ provider: 'google' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_connected');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("REFUSE de supprimer si c'est le DERNIER provider (anti-lockout 409)", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: 'a1', provider: 'google' },
    ]);
    const { DELETE } = await import('@/app/api/account/connected-providers/[provider]/route');
    const res = await DELETE(makeReq(), { params: Promise.resolve({ provider: 'google' }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('last_login_method');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('happy path : supprime Google quand Microsoft + Credentials restent', async () => {
    findManyMock.mockResolvedValueOnce([
      { id: 'a1', provider: 'google' },
      { id: 'a2', provider: 'microsoft-entra-id' },
      { id: 'a3', provider: 'credentials' },
    ]);
    deleteMock.mockResolvedValueOnce({ id: 'a1' });

    const { DELETE } = await import('@/app/api/account/connected-providers/[provider]/route');
    const res = await DELETE(makeReq(), { params: Promise.resolve({ provider: 'google' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, provider: 'google' });
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'a1' } });
  });

  it('happy path : supprime Microsoft quand Google reste (2 providers OAuth, pas last)', async () => {
    findManyMock.mockResolvedValueOnce([
      { id: 'a1', provider: 'google' },
      { id: 'a2', provider: 'microsoft-entra-id' },
    ]);
    deleteMock.mockResolvedValueOnce({ id: 'a2' });

    const { DELETE } = await import('@/app/api/account/connected-providers/[provider]/route');
    const res = await DELETE(makeReq(), { params: Promise.resolve({ provider: 'microsoft-entra-id' }) });
    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'a2' } });
  });
});
