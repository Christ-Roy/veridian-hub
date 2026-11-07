import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: vi.fn(async () => ({})) }));

import { pushUserToApps } from '@/lib/identity/push-user';
import { isAuthRecent, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { isSessionRevoked, revokeAllSessions } from '@/lib/auth/session-revocation';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

const avec = (row: unknown) => ({ user: { findUnique: vi.fn(async () => row) } }) as never;
const T = 1_800_000_000;

describe('isSessionRevoked', () => {
  it('compte supprimé : révoquée', async () => {
    expect(await isSessionRevoked(avec(null), { uid: 'u', authAt: T })).toBe(true);
  });
  it('rien de posé : valable', async () => {
    expect(await isSessionRevoked(avec({ sessionsValidAfter: null }), { uid: 'u', authAt: T })).toBe(false);
  });
  it('connexion avant la révocation : révoquée ; après : valable', async () => {
    const r = avec({ sessionsValidAfter: new Date(T * 1000) });
    expect(await isSessionRevoked(r, { uid: 'u', authAt: T - 1 })).toBe(true);
    expect(await isSessionRevoked(r, { uid: 'u', authAt: T })).toBe(false);
  });
  it('un iat réécrit après la révocation ne sauve pas une vieille connexion', async () => {
    const r = avec({ sessionsValidAfter: new Date(T * 1000) });
    const relu = { uid: 'u', authAt: T - 1, iat: T + 3600 } as never;
    expect(await isSessionRevoked(r, relu)).toBe(true);
  });
  it('jeton sans date : révoquée dès qu\'une révocation existe', async () => {
    expect(await isSessionRevoked(avec({ sessionsValidAfter: new Date(T * 1000) }), { uid: 'u' })).toBe(true);
  });
  it('impersonation : hors révocation du compte, mais pas d\'un compte supprimé', async () => {
    const r = avec({ sessionsValidAfter: new Date(T * 1000) });
    expect(await isSessionRevoked(r, { uid: 'u', authAt: T - 9, impersonated: true })).toBe(false);
    expect(await isSessionRevoked(avec(null), { uid: 'u', authAt: T, impersonated: true })).toBe(true);
  });
  it('base en panne : on ne déconnecte personne', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = { user: { findUnique: vi.fn(async () => { throw new Error('down'); }) } } as never;
    expect(await isSessionRevoked(p, { uid: 'u', authAt: T })).toBe(false);
  });
});

describe('revokeAllSessions', () => {
  it('pose la date et demande aux apps de couper leurs sessions', async () => {
    const update = vi.fn(async () => ({}));
    await revokeAllSessions({ user: { update } } as never, { id: 'u', supabaseUserId: 'uuid' });
    expect((update.mock.calls[0] as never as [{ data: { sessionsValidAfter: Date } }])[0].data.sessionsValidAfter).toBeInstanceOf(Date);
    expect(pushUserToApps).toHaveBeenCalledWith({ hubUserId: 'uuid', revokeSessions: true });
  });
});

describe('isAuthRecent', () => {
  it('borne la preuve récente', () => {
    const now = T * 1000;
    expect(isAuthRecent(T - 60, PREUVE_COMPTE_S, now)).toBe(true);
    expect(isAuthRecent(T - PREUVE_COMPTE_S - 1, PREUVE_COMPTE_S, now)).toBe(false);
    expect(isAuthRecent(undefined, PREUVE_COMPTE_S, now)).toBe(false);
  });
});
