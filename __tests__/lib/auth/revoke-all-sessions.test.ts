/**
 * D9 : `revokeAllSessions` dit quelles apps n'ont pas confirmé la coupure. Avant, le résultat
 * du push était jeté : le Hub répondait « ok » pendant que l'app gardait la session.
 */
import { describe, it, expect, vi } from 'vitest';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: pushMock }));

import { revokeAllSessions } from '@/lib/auth/session-revocation';

const prisma = { user: { update: vi.fn(async () => ({})) } } as never;

describe('revokeAllSessions : accusé des apps (D9)', () => {
  it('renvoie les apps qui n ont pas confirmé la coupure', async () => {
    pushMock.mockResolvedValue({ notifuse: 'failed', prospection: 'ok', rybbit: 'endpoint_missing' });
    const res = await revokeAllSessions(prisma, { id: 'u1', supabaseUserId: 'hub-1' });
    expect(res.appsEnEchec.sort()).toEqual(['notifuse', 'rybbit']);
    expect(pushMock).toHaveBeenCalledWith({ hubUserId: 'hub-1', revokeSessions: true });
  });

  it('une app absente du compte (not_in_app) n est pas un échec', async () => {
    pushMock.mockResolvedValue({ notifuse: 'not_in_app', prospection: 'ok' });
    const res = await revokeAllSessions(prisma, { id: 'u1', supabaseUserId: 'hub-1' });
    expect(res.appsEnEchec).toEqual([]);
  });

  it('compte sans identifiant Hub relayé : rien à pousser, aucun échec', async () => {
    pushMock.mockClear();
    const res = await revokeAllSessions(prisma, { id: 'u1', supabaseUserId: null });
    expect(res.appsEnEchec).toEqual([]);
    expect(pushMock).not.toHaveBeenCalled();
  });
});
