/**
 * Tests pour PATCH /api/workspace/[id]/rename
 *
 * Couvre :
 *  - 401 si non authentifié (requireUser throws Response)
 *  - 400 si body manque ou name vide
 *  - 400 si JSON invalide
 *  - 404 si workspace introuvable / deleted
 *  - 403 si user.id !== workspace.ownerId
 *  - 200 + DB updated + audit log écrit si OK
 *  - 200 + no-op si même nom (idempotent)
 *  - trim côté Zod (avant validation min/max)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireUserMock = vi.fn();
const findFirstMock = vi.fn();
const updateMock = vi.fn();
const writeAuditLogMock = vi.fn();

vi.mock('@/lib/auth/get-user', () => ({
  requireUser: () => requireUserMock(),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    workspace: {
      findFirst: findFirstMock,
      update: updateMock,
    },
  },
}));
vi.mock('@/lib/admin/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...args),
}));

beforeEach(() => {
  requireUserMock.mockReset();
  findFirstMock.mockReset();
  updateMock.mockReset();
  writeAuditLogMock.mockReset();
});

const makeReq = (body: unknown) =>
  new Request('http://x/api/workspace/wks-1/rename', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const makeCtx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('PATCH /api/workspace/[id]/rename', () => {
  it('401 si requireUser throws Response', async () => {
    requireUserMock.mockRejectedValueOnce(
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    );
    const { PATCH } = await import('@/app/api/workspace/[id]/rename/route');
    const res = await PATCH(makeReq({ name: 'New' }) as never, makeCtx('wks-1') as never);
    expect(res.status).toBe(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it('400 si JSON invalide', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'u1', email: 'u@x.com' });
    const { PATCH } = await import('@/app/api/workspace/[id]/rename/route');
    const res = await PATCH(makeReq('garbage') as never, makeCtx('wks-1') as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_json');
  });

  it('400 si name manque', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'u1', email: 'u@x.com' });
    const { PATCH } = await import('@/app/api/workspace/[id]/rename/route');
    const res = await PATCH(makeReq({}) as never, makeCtx('wks-1') as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_payload');
  });

  it('400 si name vide (après trim)', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'u1', email: 'u@x.com' });
    const { PATCH } = await import('@/app/api/workspace/[id]/rename/route');
    const res = await PATCH(
      makeReq({ name: '   ' }) as never,
      makeCtx('wks-1') as never,
    );
    expect(res.status).toBe(400);
  });

  it('400 si name > 80 caractères', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'u1', email: 'u@x.com' });
    const { PATCH } = await import('@/app/api/workspace/[id]/rename/route');
    const res = await PATCH(
      makeReq({ name: 'x'.repeat(81) }) as never,
      makeCtx('wks-1') as never,
    );
    expect(res.status).toBe(400);
  });

  it('404 si workspace introuvable', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'u1', email: 'u@x.com' });
    findFirstMock.mockResolvedValueOnce(null);
    const { PATCH } = await import('@/app/api/workspace/[id]/rename/route');
    const res = await PATCH(
      makeReq({ name: 'New Name' }) as never,
      makeCtx('wks-missing') as never,
    );
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('403 si user.id !== workspace.ownerId', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'u1', email: 'u@x.com' });
    findFirstMock.mockResolvedValueOnce({
      id: 'wks-1',
      name: 'Old',
      ownerId: 'other-user-id',
    });
    const { PATCH } = await import('@/app/api/workspace/[id]/rename/route');
    const res = await PATCH(
      makeReq({ name: 'New Name' }) as never,
      makeCtx('wks-1') as never,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden_not_owner');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('200 + DB updated + audit log si OK', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'u1', email: 'u@x.com' });
    findFirstMock.mockResolvedValueOnce({
      id: 'wks-1',
      name: 'Old',
      ownerId: 'u1',
    });
    updateMock.mockResolvedValueOnce({ id: 'wks-1', name: 'New Name' });

    const { PATCH } = await import('@/app/api/workspace/[id]/rename/route');
    const res = await PATCH(
      makeReq({ name: 'New Name' }) as never,
      makeCtx('wks-1') as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: 'wks-1', name: 'New Name' });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'wks-1' },
      data: { name: 'New Name' },
      select: { id: true, name: true },
    });
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'workspace.rename',
        actor: 'user:u1',
        targetId: 'wks-1',
        payload: { previous_name: 'Old', new_name: 'New Name' },
      }),
    );
  });

  it('200 no-op si même nom (idempotent, pas d\'update DB)', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'u1', email: 'u@x.com' });
    findFirstMock.mockResolvedValueOnce({
      id: 'wks-1',
      name: 'SameName',
      ownerId: 'u1',
    });

    const { PATCH } = await import('@/app/api/workspace/[id]/rename/route');
    const res = await PATCH(
      makeReq({ name: 'SameName' }) as never,
      makeCtx('wks-1') as never,
    );

    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('trim côté Zod (espaces autour de name)', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'u1', email: 'u@x.com' });
    findFirstMock.mockResolvedValueOnce({
      id: 'wks-1',
      name: 'Old',
      ownerId: 'u1',
    });
    updateMock.mockResolvedValueOnce({ id: 'wks-1', name: 'Trimmed' });

    const { PATCH } = await import('@/app/api/workspace/[id]/rename/route');
    await PATCH(
      makeReq({ name: '   Trimmed   ' }) as never,
      makeCtx('wks-1') as never,
    );
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'Trimmed' } }),
    );
  });
});
