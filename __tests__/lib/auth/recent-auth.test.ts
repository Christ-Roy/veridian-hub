/**
 * D5 : une session impersonée ne change ni mot de passe ni email. La preuve récente ne
 * vaut pas pour elle (un admin ou quiconque détient le lien ne doit pas verrouiller le compte).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({ auth: authMock }));

import {
  denyIfImpersonated,
  denyUnlessRecentAuth,
  PREUVE_COMPTE_S,
  PREUVE_FACTURATION_S,
} from '@/lib/auth/recent-auth';

describe('denyIfImpersonated (D5)', () => {
  beforeEach(() => authMock.mockReset());

  it('session impersonée : 403 explicite', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', impersonated: true, authAt: Date.now() / 1000 } });
    const res = await denyIfImpersonated();
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ error: 'impersonation_interdite' });
  });

  it('session normale : permis', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', authAt: Date.now() / 1000 } });
    expect(await denyIfImpersonated()).toBeNull();
  });
});

describe('denyUnlessRecentAuth (D12)', () => {
  beforeEach(() => authMock.mockReset());

  it('connexion d il y a 2 jours : refusée pour le compte (24 h), permise pour la facturation (7 j)', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1', authAt: Date.now() / 1000 - 2 * 86400 } });
    const compte = await denyUnlessRecentAuth(PREUVE_COMPTE_S);
    expect(compte?.status).toBe(403);
    expect(await compte?.json()).toMatchObject({ error: 'recent_auth_required', login_url: '/login?reauth=1' });
    expect(await denyUnlessRecentAuth(PREUVE_FACTURATION_S)).toBeNull();
  });

  it('session sans date de connexion réelle : refusée', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1' } });
    expect((await denyUnlessRecentAuth(PREUVE_COMPTE_S))?.status).toBe(403);
  });
});
