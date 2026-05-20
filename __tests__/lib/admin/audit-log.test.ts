/**
 * Tests pour lib/admin/audit-log.ts
 *
 * Couvre :
 *  - writeAuditLog appelle prisma.auditLog.create avec les bons champs
 *  - resolveActor priorité session > x-admin-secret > x-hub-admin-token
 *  - Best-effort : si prisma throw, on ne propage pas (juste console.error)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeAuditLog, resolveActor } from '@/lib/admin/audit-log';

const createMock = vi.fn();
const prisma = { auditLog: { create: createMock } } as never;

beforeEach(() => {
  createMock.mockReset();
});

describe('writeAuditLog', () => {
  it('appelle prisma.auditLog.create avec les bons champs', async () => {
    createMock.mockResolvedValueOnce({});
    await writeAuditLog(prisma, {
      action: 'admin.user.create',
      actor: 'admin:robert@x',
      targetType: 'user',
      targetId: 'u1',
      payload: { foo: 'bar' },
    });
    expect(createMock).toHaveBeenCalledWith({
      data: {
        action: 'admin.user.create',
        actor: 'admin:robert@x',
        targetType: 'user',
        targetId: 'u1',
        payload: { foo: 'bar' },
      },
    });
  });

  it('accepte les champs targetType/targetId/payload optionnels', async () => {
    createMock.mockResolvedValueOnce({});
    await writeAuditLog(prisma, {
      action: 'admin.something',
      actor: 'token:X',
    });
    expect(createMock).toHaveBeenCalled();
    const data = createMock.mock.calls[0][0].data;
    expect(data.action).toBe('admin.something');
    expect(data.payload).toBeNull();
  });

  it('swallow les erreurs Prisma (best-effort)', async () => {
    createMock.mockRejectedValueOnce(new Error('DB down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Ne doit PAS throw
    await expect(
      writeAuditLog(prisma, { action: 'x', actor: 'y' })
    ).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('resolveActor', () => {
  it("priorise la session si l'email est fourni", () => {
    expect(
      resolveActor(new Headers({ 'x-admin-secret': '1' }), 'alice@x')
    ).toBe('admin:alice@x');
  });

  it('utilise x-admin-secret si pas de session', () => {
    expect(resolveActor(new Headers({ 'x-admin-secret': '1' }), null)).toBe(
      'token:ADMIN_SECRET'
    );
  });

  it('utilise x-hub-admin-token si pas de session ni admin-secret', () => {
    expect(
      resolveActor(new Headers({ 'x-hub-admin-token': '2' }), null)
    ).toBe('token:HUB_ADMIN_TOKEN');
  });

  it('retourne "unknown" si rien', () => {
    expect(resolveActor(new Headers({}), null)).toBe('unknown');
    expect(resolveActor(new Headers({}), undefined)).toBe('unknown');
  });
});
