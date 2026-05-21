/**
 * Tests unitaires de `lib/workspace/provision.ts`.
 *
 * Régression cible : 100 % des 23 users prod sans workspace au 2026-05-21
 * (provisioning au signup jamais câblé). Ce module ferme le trou — tout
 * nouveau user (signup Credentials, OAuth Google, OAuth Microsoft) reçoit
 * un workspace + member OWNER. Backfill prod pour rattraper les 23.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  provisionDefaultWorkspace,
  defaultWorkspaceName,
} from '@/lib/workspace/provision';

function makeDeps(opts: {
  existingMembership?: { workspace: { id: string; name: string } } | null;
  createWorkspaceThrows?: boolean;
  auditLogThrows?: boolean;
} = {}) {
  const findFirst = vi.fn(async () => opts.existingMembership ?? null);

  const txWorkspaceCreate = vi.fn(async ({ data, select }: any) => {
    if (opts.createWorkspaceThrows) throw new Error('DB down');
    const ws = { id: 'ws-new-1', name: data.name };
    return select ? ws : ws;
  });
  const txMemberCreate = vi.fn(async () => ({ id: 'wm-new-1' }));
  const txContext = {
    workspace: { create: txWorkspaceCreate },
    workspaceMember: { create: txMemberCreate },
  };

  const $transaction = vi.fn(async (cb: any) => cb(txContext));

  const auditCreate = vi.fn(async () => {
    if (opts.auditLogThrows) throw new Error('audit down');
    return { id: 'audit-1' };
  });

  const prisma: any = {
    workspaceMember: { findFirst },
    $transaction,
    auditLog: { create: auditCreate },
  };

  const logger = { error: vi.fn(), info: vi.fn() };

  return {
    prisma,
    logger,
    _findFirst: findFirst,
    _txWorkspaceCreate: txWorkspaceCreate,
    _txMemberCreate: txMemberCreate,
    _$transaction: $transaction,
    _auditCreate: auditCreate,
  };
}

describe('defaultWorkspaceName — convention de nommage', () => {
  it('utilise user.name si présent', () => {
    expect(defaultWorkspaceName({ name: 'Alice Smith', email: 'a@x.io' })).toBe('Alice Smith workspace');
  });

  it('fallback sur la partie locale de l\'email si name absent', () => {
    expect(defaultWorkspaceName({ name: null, email: 'bob@example.com' })).toBe('bob workspace');
  });

  it('trim les espaces parasites dans le name', () => {
    expect(defaultWorkspaceName({ name: '  Charlie  ', email: 'c@x.io' })).toBe('Charlie workspace');
  });

  it('fallback "user" si email malformé (pas de @)', () => {
    expect(defaultWorkspaceName({ name: null, email: 'broken' })).toBe('broken workspace');
  });
});

describe('provisionDefaultWorkspace — création initiale', () => {
  it('user neuf → crée workspace + WorkspaceMember role=OWNER en transaction', async () => {
    const deps = makeDeps();
    const result = await provisionDefaultWorkspace(
      { userId: 'u-new', email: 'fresh@gmail.com', name: 'Fresh User' },
      deps
    );

    expect(result.created).toBe(true);
    expect(result.workspaceId).toBe('ws-new-1');
    expect(result.workspaceName).toBe('Fresh User workspace');

    // Transaction exécutée
    expect(deps._$transaction).toHaveBeenCalledTimes(1);
    expect(deps._txWorkspaceCreate).toHaveBeenCalledWith({
      data: { name: 'Fresh User workspace', ownerId: 'u-new' },
      select: { id: true, name: true },
    });
    expect(deps._txMemberCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'ws-new-1',
        userId: 'u-new',
        role: 'OWNER',
        joinedAt: expect.any(Date),
      }),
    });

    // Audit log écrit
    expect(deps._auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'workspace.provision.signup',
          actor: 'system:signup',
          targetType: 'user',
          targetId: 'u-new',
        }),
      })
    );

    expect(deps.logger.info).toHaveBeenCalled();
  });
});

describe('provisionDefaultWorkspace — idempotence', () => {
  it('user déjà membre d\'un workspace actif → renvoie l\'existant sans créer', async () => {
    const deps = makeDeps({
      existingMembership: {
        workspace: { id: 'ws-existing-42', name: 'Existing Team' },
      } as any,
    });
    const result = await provisionDefaultWorkspace(
      { userId: 'u-already', email: 'member@x.io' },
      deps
    );

    expect(result.created).toBe(false);
    expect(result.workspaceId).toBe('ws-existing-42');
    expect(result.workspaceName).toBe('Existing Team');

    // Pas de transaction, pas de create, pas d'audit
    expect(deps._$transaction).not.toHaveBeenCalled();
    expect(deps._txWorkspaceCreate).not.toHaveBeenCalled();
    expect(deps._auditCreate).not.toHaveBeenCalled();
  });

  it('détection idempotence filtre les workspaces deletedAt non-null', async () => {
    const deps = makeDeps();
    await provisionDefaultWorkspace({ userId: 'u-x', email: 'x@x.io' }, deps);

    expect(deps._findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'u-x',
        workspace: { deletedAt: null },
      },
      include: { workspace: { select: { id: true, name: true } } },
    });
  });
});

describe('provisionDefaultWorkspace — résilience', () => {
  it('audit log qui throw n\'empêche pas le provisioning (best-effort)', async () => {
    const deps = makeDeps({ auditLogThrows: true });
    const result = await provisionDefaultWorkspace(
      { userId: 'u-audit-fail', email: 'a@x.io' },
      deps
    );
    expect(result.created).toBe(true);
    expect(result.workspaceId).toBe('ws-new-1');
  });

  it('actor personnalisé propagé dans l\'audit log (backfill script)', async () => {
    const deps = makeDeps();
    await provisionDefaultWorkspace(
      { userId: 'u-bf', email: 'bf@x.io' },
      { ...deps, actor: 'script:backfill-workspaces' }
    );

    expect(deps._auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actor: 'script:backfill-workspaces',
        }),
      })
    );
  });

  it('transaction qui throw remonte l\'erreur au caller (le caller décide)', async () => {
    const deps = makeDeps({ createWorkspaceThrows: true });
    await expect(
      provisionDefaultWorkspace({ userId: 'u-fail', email: 'f@x.io' }, deps)
    ).rejects.toThrow('DB down');
  });
});
