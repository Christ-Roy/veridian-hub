/**
 * Tests pour lib/admin/audit-log.ts
 *
 * Couvre :
 *  - writeAuditLog appelle prisma.auditLog.create avec les bons champs
 *  - resolveActor priorité session > x-admin-secret > x-hub-admin-token
 *  - Best-effort : si prisma throw, on ne propage pas (juste console.error)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeAuditLog, resolveActor, findAuditByActor } from '@/lib/admin/audit-log';

const createMock = vi.fn();
const findManyMock = vi.fn();
const prisma = {
  auditLog: { create: createMock, findMany: findManyMock },
} as never;

beforeEach(() => {
  createMock.mockReset();
  findManyMock.mockReset();
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

  it("accepte targetType 'tenant_app' (activation d'app gated par tenant)", async () => {
    // Ajouté 2026-05-29 : l'endpoint /api/admin/tenants/app-access journalise
    // avec targetType 'tenant_app'. Garde-fou de non-régression du union type
    // (un build a déjà cassé en oubliant cette valeur dans AuditEvent).
    createMock.mockResolvedValueOnce({});
    await writeAuditLog(prisma, {
      action: 'admin.tenant.app_access',
      actor: 'token:ADMIN_SECRET',
      targetType: 'tenant_app',
      targetId: 'uuid-1',
      payload: { app: 'twenty', enabled: true },
    });
    expect(createMock).toHaveBeenCalledWith({
      data: {
        action: 'admin.tenant.app_access',
        actor: 'token:ADMIN_SECRET',
        targetType: 'tenant_app',
        targetId: 'uuid-1',
        payload: { app: 'twenty', enabled: true },
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

describe('findAuditByActor', () => {
  it('query par actor avec orderBy createdAt DESC et limit default 100', async () => {
    findManyMock.mockResolvedValueOnce([]);
    await findAuditByActor(prisma, 'admin:robert@x');

    expect(findManyMock).toHaveBeenCalledWith({
      where: { actor: 'admin:robert@x' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  it('respecte le limit fourni', async () => {
    findManyMock.mockResolvedValueOnce([]);
    await findAuditByActor(prisma, 'token:ADMIN_SECRET', { limit: 20 });
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 })
    );
  });

  it('filtre par date si `since` fourni', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const since = new Date('2026-05-01');
    await findAuditByActor(prisma, 'admin:x@y', { since });
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { actor: 'admin:x@y', createdAt: { gte: since } },
      })
    );
  });

  it('retourne les rows tels quels (forensics raw, pas de transformation)', async () => {
    const fakeRows = [
      {
        id: 'a1',
        action: 'admin.user.create',
        actor: 'admin:x',
        targetType: 'user',
        targetId: 'u1',
        payload: { email: 'a@x.com' },
        createdAt: new Date('2026-05-20'),
      },
    ];
    findManyMock.mockResolvedValueOnce(fakeRows);
    const result = await findAuditByActor(prisma, 'admin:x');
    expect(result).toEqual(fakeRows);
  });
});
