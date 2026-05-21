/**
 * Tests unitaires de `lib/auth/create-user-event.ts`.
 *
 * Régressions cibles :
 *  1. OAuth Hub 2026-05-21 : 2 users OAuth orphelins (tramtechservices +
 *     augustindemaret) créés sans `supabaseUserId` → Dashboard Layout en
 *     panne en boucle. L'event patch maintenant la colonne.
 *  2. Workspace provisioning 2026-05-21 : 23 users prod sans workspace →
 *     page /dashboard/workspace/members inaccessible. L'event provisionne
 *     un workspace par défaut au signup OAuth.
 *
 * Les 2 étapes sont **isolées** : un échec de l'une ne casse pas l'autre.
 * Contrat Auth.js v5 events : `Promise<void>`, jamais throw.
 */

import { describe, it, expect, vi } from 'vitest';
import { createCreateUserEvent } from '@/lib/auth/create-user-event';

function makeDeps(opts: {
  existingSupabaseUserId?: string | null;
  findUniqueThrows?: boolean;
  updateThrows?: boolean;
  fixedUuid?: string;
  provisionThrows?: boolean;
  provisionResult?: { workspaceId: string; created: boolean; workspaceName: string };
} = {}) {
  const findUnique = vi.fn(async () => {
    if (opts.findUniqueThrows) throw new Error('DB down');
    return opts.existingSupabaseUserId === undefined
      ? { supabaseUserId: null }
      : { supabaseUserId: opts.existingSupabaseUserId };
  });
  const update = vi.fn(async () => {
    if (opts.updateThrows) throw new Error('DB down');
    return { id: 'u1' };
  });
  const generateUuid = vi.fn(() => opts.fixedUuid ?? '11111111-1111-4111-8111-111111111111');
  const logger = { error: vi.fn(), info: vi.fn() };
  const provisionWorkspace = vi.fn(async () => {
    if (opts.provisionThrows) throw new Error('workspace provision failed');
    return opts.provisionResult ?? { workspaceId: 'ws-1', created: true, workspaceName: 'default workspace' };
  });
  return {
    prisma: { user: { findUnique, update } } as never,
    generateUuid,
    logger,
    provisionWorkspace: provisionWorkspace as never,
    _findUnique: findUnique,
    _update: update,
    _provisionWorkspace: provisionWorkspace,
  };
}

describe('createCreateUserEvent — patch supabaseUserId post PrismaAdapter', () => {
  it('OAuth Google fresh user → patch avec UUID v4 généré', async () => {
    const deps = makeDeps();
    const event = createCreateUserEvent(deps);

    await event({ user: { id: 'cm123', email: 'fresh@gmail.com' } });

    expect(deps._findUnique).toHaveBeenCalledWith({
      where: { id: 'cm123' },
      select: { supabaseUserId: true },
    });
    expect(deps._update).toHaveBeenCalledWith({
      where: { id: 'cm123' },
      data: { supabaseUserId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(deps.logger.info).toHaveBeenCalled();
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it('idempotent : user déjà patché (supabaseUserId déjà set) → ne re-patch pas', async () => {
    const deps = makeDeps({ existingSupabaseUserId: 'aaaa-bbbb' });
    const event = createCreateUserEvent(deps);

    await event({ user: { id: 'cm123', email: 'already@gmail.com' } });

    expect(deps._findUnique).toHaveBeenCalled();
    expect(deps._update).not.toHaveBeenCalled();
    expect(deps.generateUuid).not.toHaveBeenCalled();
  });

  it('user.id manquant → log error, ne touche pas la DB', async () => {
    const deps = makeDeps();
    const event = createCreateUserEvent(deps);

    await event({ user: { id: null, email: 'oops@gmail.com' } });

    expect(deps._findUnique).not.toHaveBeenCalled();
    expect(deps._update).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[auth-event:createUser]'),
    );
  });

  it('findUnique throw → log error, ne throw pas (contrat Auth.js v5 events)', async () => {
    const deps = makeDeps({ findUniqueThrows: true });
    const event = createCreateUserEvent(deps);

    await expect(
      event({ user: { id: 'cm123', email: 'err@gmail.com' } }),
    ).resolves.toBeUndefined();

    expect(deps.logger.error).toHaveBeenCalledWith(
      '[auth-event:createUser] failed to patch supabaseUserId',
      expect.any(Error),
    );
    expect(deps._update).not.toHaveBeenCalled();
  });

  it('update throw → log error, ne throw pas', async () => {
    const deps = makeDeps({ updateThrows: true });
    const event = createCreateUserEvent(deps);

    await expect(
      event({ user: { id: 'cm123', email: 'err@gmail.com' } }),
    ).resolves.toBeUndefined();

    expect(deps.logger.error).toHaveBeenCalledWith(
      '[auth-event:createUser] failed to patch supabaseUserId',
      expect.any(Error),
    );
  });

  it('UUID factory injectée appelée exactement 1 fois par user fresh', async () => {
    const deps = makeDeps({ fixedUuid: 'deadbeef-dead-4ead-bead-deadbeefdead' });
    const event = createCreateUserEvent(deps);

    await event({ user: { id: 'cm1', email: 'a@gmail.com' } });
    await event({ user: { id: 'cm2', email: 'b@gmail.com' } });

    expect(deps.generateUuid).toHaveBeenCalledTimes(2);
  });
});

describe('createCreateUserEvent — provisioning workspace par défaut', () => {
  it('OAuth user fresh → provisionWorkspace appelé avec userId + email + name', async () => {
    const deps = makeDeps();
    const event = createCreateUserEvent(deps);

    await event({ user: { id: 'cm-ws', email: 'ws@gmail.com', name: 'WS User' } });

    expect(deps._provisionWorkspace).toHaveBeenCalledWith(
      { userId: 'cm-ws', email: 'ws@gmail.com', name: 'WS User' },
      expect.objectContaining({
        actor: 'system:oauth-signup',
      })
    );
  });

  it('provisioning idempotent (created=false) → ne log pas le created message', async () => {
    const deps = makeDeps({
      provisionResult: { workspaceId: 'ws-existing', created: false, workspaceName: 'Existing' },
    });
    const event = createCreateUserEvent(deps);

    await event({ user: { id: 'cm-idem', email: 'idem@gmail.com' } });

    // Le info log "provisioned default workspace" ne doit PAS apparaître si created=false.
    // (le info log de supabaseUserId est tracé séparément — donc 1 seul info attendu pour le supabaseUserId)
    const provisionMsgs = deps.logger.info.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes('provisioned default workspace'))
    );
    expect(provisionMsgs).toHaveLength(0);
  });

  it('provisioning throw → log error, le supabaseUserId est quand même patché', async () => {
    const deps = makeDeps({ provisionThrows: true });
    const event = createCreateUserEvent(deps);

    await expect(
      event({ user: { id: 'cm-ws-err', email: 'wse@gmail.com' } })
    ).resolves.toBeUndefined();

    expect(deps._update).toHaveBeenCalled(); // étape 1 a bien tourné
    expect(deps.logger.error).toHaveBeenCalledWith(
      '[auth-event:createUser] failed to provision default workspace',
      expect.any(Error),
    );
  });

  it('user.email manquant → skip workspace provision, log error', async () => {
    const deps = makeDeps();
    const event = createCreateUserEvent(deps);

    await event({ user: { id: 'cm-no-email', email: null } });

    expect(deps._provisionWorkspace).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('user.email missing'),
    );
  });
});
