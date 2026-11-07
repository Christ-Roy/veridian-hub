/**
 * D5 : une session impersonée ne change ni mot de passe ni email. La preuve récente ne
 * vaut pas pour elle (un admin ou quiconque détient le lien ne doit pas verrouiller le compte).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/auth', () => ({ auth: authMock }));

import { denyIfImpersonated } from '@/lib/auth/recent-auth';

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
