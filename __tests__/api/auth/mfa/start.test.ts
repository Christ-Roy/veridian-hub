/**
 * D3 : `POST /api/auth/mfa/start` vérifie le mot de passe. Un compte à double vérification reçoit
 * le code par mail et le cookie d'étape 1 ; il n'obtient aucune session ici.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

const { findUniqueMock, issueMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  issueMock: vi.fn(async () => undefined),
}));

vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: findUniqueMock } } }));
vi.mock('@/lib/mfa', () => ({
  issueAndSendMfaCode: issueMock,
  MfaRateLimitError: class extends Error {},
}));

import { POST } from '@/app/api/auth/mfa/start/route';
import { mfaStep1CookieName } from '@/lib/auth/mfa-step1';
import { ECHECS_MAX, nomCookieAppareil, plafondCompte } from '@/lib/auth/plafond-compte';

let ip = 0;
function req(body: unknown) {
  ip += 1;
  return new Request('http://localhost/api/auth/mfa/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${ip % 250}`, 'cf-connecting-ip': `9.9.${ip}.1` },
    body: JSON.stringify(body),
  });
}

const HASH = bcrypt.hashSync('motdepasse1', 4);

beforeAll(() => {
  process.env.AUTH_SECRET = 'secret-de-test-au-moins-32-octets-xxxxxxxx';
});
beforeEach(() => {
  issueMock.mockClear();
  plafondCompte.reset();
});

describe('POST /api/auth/mfa/start (D3)', () => {
  it('mauvais mot de passe : 401, aucun code envoyé', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'u1', email: 'a@b.fr', mfaEnabled: true, accounts: [{ provider: 'credentials', access_token: HASH }],
    });
    const res = await POST(req({ email: 'a@b.fr', password: 'faux-motdepasse' }));
    expect(res.status).toBe(401);
    expect(issueMock).not.toHaveBeenCalled();
  });

  it('compte sans double vérification : mfa=false, pas de code, pas de cookie', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'u2', email: 'a@b.fr', mfaEnabled: false, accounts: [{ provider: 'credentials', access_token: HASH }],
    });
    const res = await POST(req({ email: 'a@b.fr', password: 'motdepasse1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mfa: false });
    expect(issueMock).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie') ?? '').not.toContain(mfaStep1CookieName(false));
  });

  it('double vérification : code envoyé et cookie d\'étape 1 posé, sans session', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'u3', email: 'mfa@b.fr', mfaEnabled: true, accounts: [{ provider: 'credentials', access_token: HASH }],
    });
    const res = await POST(req({ email: 'MFA@b.fr ', password: 'motdepasse1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mfa: true });
    expect(issueMock).toHaveBeenCalledWith({ id: 'u3', email: 'mfa@b.fr' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${mfaStep1CookieName(false)}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('authjs.session-token');
  });

  it('plafond par compte : échecs depuis des IP différentes, puis 429 même avec le bon mot de passe, et aucun code envoyé', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'u4', email: 'cible@b.fr', mfaEnabled: true, accounts: [{ provider: 'credentials', access_token: HASH }],
    });
    for (let i = 0; i < ECHECS_MAX; i++) expect((await POST(req({ email: 'cible@b.fr', password: 'faux-motdepasse' }))).status).toBe(401);
    const r = await POST(req({ email: 'cible@b.fr', password: 'motdepasse1' }));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(issueMock).not.toHaveBeenCalled();
  });

  it('entrée réussie : le navigateur devient connu de ce compte ; jamais sur un échec ni avant le code MFA', async () => {
    const compte = (mfaEnabled: boolean) => ({ id: 'u5', email: 'c@b.fr', mfaEnabled, accounts: [{ provider: 'credentials', access_token: HASH }] });
    findUniqueMock.mockResolvedValue(compte(false));
    expect((await POST(req({ email: 'c@b.fr', password: 'motdepasse1' }))).headers.get('set-cookie') ?? '').toContain(`${nomCookieAppareil()}=`);
    expect((await POST(req({ email: 'c@b.fr', password: 'faux-motdepasse' }))).headers.get('set-cookie') ?? '').not.toContain(nomCookieAppareil());
    findUniqueMock.mockResolvedValue(compte(true));
    expect((await POST(req({ email: 'c@b.fr', password: 'motdepasse1' }))).headers.get('set-cookie') ?? '').not.toContain(nomCookieAppareil());
  });
});
