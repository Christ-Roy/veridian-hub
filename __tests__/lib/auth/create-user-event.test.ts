/**
 * Tests unitaires de `lib/auth/create-user-event.ts`.
 *
 * Régression OAuth Hub 2026-05-21 : 2 users OAuth orphelins
 * (tramtechservices@gmail.com et augustindemaret@gmail.com) créés sans
 * `supabaseUserId` → Dashboard Layout en panne en boucle.
 *
 * Cet event ferme le trou : tout user créé par le PrismaAdapter (= OAuth
 * Google + Microsoft) reçoit automatiquement un UUID v4 dans `supabaseUserId`
 * juste après création.
 */

import { describe, it, expect, vi } from 'vitest';
import { createCreateUserEvent } from '@/lib/auth/create-user-event';

function makeDeps(opts: {
  existingSupabaseUserId?: string | null;
  findUniqueThrows?: boolean;
  updateThrows?: boolean;
  fixedUuid?: string;
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
  return {
    prisma: { user: { findUnique, update } } as never,
    generateUuid,
    logger,
    _findUnique: findUnique,
    _update: update,
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
