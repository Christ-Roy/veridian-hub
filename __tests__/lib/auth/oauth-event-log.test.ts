/**
 * Tests unitaires de `lib/auth/oauth-event-log.ts`.
 *
 * Couvre :
 *  - recordOauthSuccess écrit une row event='success'
 *  - recordOauthFailure écrit une row event='failure' avec errorCode
 *  - best-effort : un échec Prisma ne throw jamais (contrat — ne casse pas le login)
 *  - normalisation provider vide → 'unknown'
 *  - clamp des champs longs (User-Agent forgé)
 */

import { describe, it, expect, vi } from 'vitest';
import { createOauthEventLogger } from '@/lib/auth/oauth-event-log';

function makeDeps(opts: { createThrows?: boolean } = {}) {
  const create = vi.fn(async () => {
    if (opts.createThrows) throw new Error('DB down');
    return { id: 'evt-1' };
  });
  const logger = { error: vi.fn() };
  return {
    prisma: { oauthSigninEvent: { create } } as never,
    logger,
    _create: create,
  };
}

describe('createOauthEventLogger — recordOauthSuccess', () => {
  it('écrit une row event=success avec provider + email', async () => {
    const deps = makeDeps();
    const log = createOauthEventLogger(deps);

    await log.recordOauthSuccess({
      provider: 'google',
      email: 'user@gmail.com',
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      durationMs: 420,
    });

    expect(deps._create).toHaveBeenCalledWith({
      data: {
        event: 'success',
        provider: 'google',
        email: 'user@gmail.com',
        ip: '1.2.3.4',
        userAgent: 'Mozilla/5.0',
        errorCode: null,
        durationMs: 420,
      },
    });
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it('champs optionnels absents → null (pas undefined)', async () => {
    const deps = makeDeps();
    const log = createOauthEventLogger(deps);

    await log.recordOauthSuccess({ provider: 'microsoft-entra-id' });

    expect(deps._create).toHaveBeenCalledWith({
      data: {
        event: 'success',
        provider: 'microsoft-entra-id',
        email: null,
        ip: null,
        userAgent: null,
        errorCode: null,
        durationMs: null,
      },
    });
  });

  it('provider vide → normalisé en "unknown"', async () => {
    const deps = makeDeps();
    const log = createOauthEventLogger(deps);

    await log.recordOauthSuccess({ provider: '' });

    expect(deps._create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ provider: 'unknown' }) }),
    );
  });
});

describe('createOauthEventLogger — recordOauthFailure', () => {
  it('écrit une row event=failure avec errorCode', async () => {
    const deps = makeDeps();
    const log = createOauthEventLogger(deps);

    await log.recordOauthFailure({ errorCode: 'OAuthCallbackError' });

    expect(deps._create).toHaveBeenCalledWith({
      data: {
        event: 'failure',
        provider: 'unknown',
        email: null,
        ip: null,
        userAgent: null,
        errorCode: 'OAuthCallbackError',
        durationMs: null,
      },
    });
  });

  it('failure avec provider + email connus', async () => {
    const deps = makeDeps();
    const log = createOauthEventLogger(deps);

    await log.recordOauthFailure({
      provider: 'google',
      email: 'flaky@gmail.com',
      errorCode: 'AccessDenied',
    });

    expect(deps._create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'failure',
          provider: 'google',
          email: 'flaky@gmail.com',
          errorCode: 'AccessDenied',
        }),
      }),
    );
  });
});

describe('createOauthEventLogger — best-effort (ne casse jamais le login)', () => {
  it('recordOauthSuccess : échec Prisma → ne throw pas, log l\'erreur', async () => {
    const deps = makeDeps({ createThrows: true });
    const log = createOauthEventLogger(deps);

    await expect(
      log.recordOauthSuccess({ provider: 'google', email: 'a@b.c' }),
    ).resolves.toBeUndefined();

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[oauth-event-log-failed]'),
    );
  });

  it('recordOauthFailure : échec Prisma → ne throw pas, log l\'erreur', async () => {
    const deps = makeDeps({ createThrows: true });
    const log = createOauthEventLogger(deps);

    await expect(
      log.recordOauthFailure({ errorCode: 'Configuration' }),
    ).resolves.toBeUndefined();

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[oauth-event-log-failed]'),
    );
  });
});

describe('createOauthEventLogger — clamp des champs longs', () => {
  it('User-Agent forgé > 1024 chars → tronqué à 1024', async () => {
    const deps = makeDeps();
    const log = createOauthEventLogger(deps);
    const hugeUa = 'A'.repeat(5000);

    await log.recordOauthSuccess({ provider: 'google', userAgent: hugeUa });

    const data = deps._create.mock.calls[0]?.[0]?.data;
    expect(data.userAgent).toHaveLength(1024);
  });

  it('errorCode forgé > 128 chars → tronqué à 128', async () => {
    const deps = makeDeps();
    const log = createOauthEventLogger(deps);

    await log.recordOauthFailure({ errorCode: 'X'.repeat(500) });

    const data = deps._create.mock.calls[0]?.[0]?.data;
    expect(data.errorCode).toHaveLength(128);
  });
});
