/**
 * D3 : `POST /api/auth/mfa/verify` exige le cookie d'étape 1, plafonne les essais, puis émet la
 * vraie session Auth.js avec `authAt` (début réel de la connexion).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { decode } from 'next-auth/jwt';

const { verifyMock, findUniqueMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: findUniqueMock } } }));
vi.mock('@/lib/mfa', () => ({ verifyMfaCode: verifyMock }));

import { POST } from '@/app/api/auth/mfa/verify/route';
import { signerEtapeUn, mfaStep1CookieName } from '@/lib/auth/mfa-step1';
import { sessionCookieName } from '@/lib/auth/impersonation';

const SECRET = 'secret-de-test-au-moins-32-octets-xxxxxxxx';
let ip = 0;

// `new Request` retire l'en-tête `cookie` dans cet environnement (garde fetch) : on passe les
// en-têtes tels quels. La route ne lit que `headers` et `json()`.
function req(body: unknown, cookie?: string) {
  ip += 1;
  const headers = new Headers({ 'content-type': 'application/json', 'x-real-ip': `10.78.0.${ip}` });
  if (cookie) headers.set('cookie', cookie);
  return { headers, json: async () => body } as unknown as Request;
}

const cookieEtapeUn = (uid: string) =>
  `${mfaStep1CookieName(false)}=${signerEtapeUn(uid, Math.floor(Date.now() / 1000), SECRET)}`;

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});
beforeEach(() => {
  verifyMock.mockReset();
  findUniqueMock.mockResolvedValue({
    id: 'u9', email: 'mfa@b.fr', name: 'M', image: null, supabaseUserId: 'h-9', mfaEnabled: true,
  });
});

describe('POST /api/auth/mfa/verify (D3)', () => {
  it('sans cookie d\'étape 1 : 401, le code n\'est même pas vérifié', async () => {
    const res = await POST(req({ code: '123456' }));
    expect(res.status).toBe(401);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('code faux : 401, pas de session', async () => {
    verifyMock.mockResolvedValue(false);
    const res = await POST(req({ code: '000000' }, cookieEtapeUn('u9')));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie') ?? '').not.toContain(sessionCookieName(false));
  });

  it('code bon : session Auth.js émise avec authAt, cookie d\'étape 1 effacé, redirection', async () => {
    verifyMock.mockResolvedValue(true);
    const before = Math.floor(Date.now() / 1000);
    const res = await POST(req({ code: '123456', next: '/dashboard/settings' }, cookieEtapeUn('u9')));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, redirect: '/dashboard/settings' });
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${sessionCookieName(false)}=`));
    expect(session).toBeTruthy();
    const token = session!.split(';')[0].slice(sessionCookieName(false).length + 1);
    const decoded = await decode({ token, secret: SECRET, salt: sessionCookieName(false) });
    expect(decoded?.uid).toBe('u9');
    expect(decoded?.authAt as number).toBeGreaterThanOrEqual(before);
    expect(cookies.find((c) => c.startsWith(`${mfaStep1CookieName(false)}=`))).toMatch(/Max-Age=0|Expires=/);
  });

  it('une cible interne invalide est remplacée par /dashboard', async () => {
    verifyMock.mockResolvedValue(true);
    const res = await POST(req({ code: '123456', next: 'https://evil.example' }, cookieEtapeUn('u9')));
    expect(await res.json()).toMatchObject({ redirect: '/dashboard' });
  });

  it('plafond d\'essais : le 6e essai dans la fenêtre est refusé (429)', async () => {
    verifyMock.mockResolvedValue(false);
    const cookie = cookieEtapeUn('u-plafond');
    let dernier = 0;
    for (let i = 0; i < 6; i++) {
      dernier = (await POST(req({ code: '000000' }, cookie))).status;
    }
    expect(dernier).toBe(429);
  });
});
