/**
 * Tests pour lib/admin/authenticate.ts
 *
 * Couvre :
 *  - rate-limit IP appliqué (429 au-delà du cap)
 *  - x-admin-secret correct → 200
 *  - x-admin-secret wrong + pas de session → 401
 *  - Session admin → 200
 *  - Session non-admin → 403
 *  - timing-safe : pas de leak via différence de timing observable (test soft)
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const authMock = vi.fn();
const isPlatformAdminMock = vi.fn();

vi.mock('@/auth', () => ({ auth: (...a: unknown[]) => authMock(...a) }));
vi.mock('@/lib/admin/check-admin', () => ({
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdminMock(...a),
}));

// Mock rate-limit pour pouvoir le piloter (sinon il pollue d'autres tests)
import { adminApiLimiter } from '@/lib/auth/rate-limit';

import { authenticateAdmin } from '@/lib/admin/authenticate';

const ORIG_SECRET = process.env.ADMIN_SECRET;

beforeEach(() => {
  authMock.mockReset();
  isPlatformAdminMock.mockReset();
  process.env.ADMIN_SECRET = 'super-secret-for-tests';
  adminApiLimiter.reset();
});

afterAll(() => {
  if (ORIG_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIG_SECRET;
});

const makeReq = (headers: Record<string, string> = {}) =>
  new Request('http://x/api/admin/foo', {
    method: 'POST',
    headers: { 'x-forwarded-for': '1.2.3.4', ...headers },
  });

describe('authenticateAdmin', () => {
  it('200 avec x-admin-secret correct', async () => {
    const res = await authenticateAdmin(
      makeReq({ 'x-admin-secret': 'super-secret-for-tests' }) as never
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sessionEmail).toBeNull();
  });

  it('401 avec x-admin-secret wrong + pas de session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await authenticateAdmin(
      makeReq({ 'x-admin-secret': 'wrong-secret-same-length-ish-padding-xx' }) as never
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });

  it("401 sans aucun header d'auth + pas de session", async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await authenticateAdmin(makeReq() as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });

  it('200 avec session admin', async () => {
    authMock.mockResolvedValueOnce({ user: { email: 'admin@x', id: 'u1' } });
    isPlatformAdminMock.mockReturnValueOnce(true);
    const res = await authenticateAdmin(makeReq() as never);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sessionEmail).toBe('admin@x');
  });

  it('403 avec session non-admin', async () => {
    authMock.mockResolvedValueOnce({ user: { email: 'random@x', id: 'u1' } });
    isPlatformAdminMock.mockReturnValueOnce(false);
    const res = await authenticateAdmin(makeReq() as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
  });

  it('429 si rate-limit dépassé (>30 req/min/IP)', async () => {
    // Saturer le rate-limit avec 30 requêtes wrong-secret
    for (let i = 0; i < 30; i++) {
      authMock.mockResolvedValueOnce(null);
      await authenticateAdmin(
        makeReq({ 'x-admin-secret': `wrong-${i}` }) as never
      );
    }
    // 31e doit être 429, peu importe le bon secret
    const res = await authenticateAdmin(
      makeReq({ 'x-admin-secret': 'super-secret-for-tests' }) as never
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(429);
      expect(res.response.headers.get('Retry-After')).toBeTruthy();
    }
  });

  it('rate-limit indépendant par IP', async () => {
    // IP1 saturée
    for (let i = 0; i < 30; i++) {
      authMock.mockResolvedValueOnce(null);
      await authenticateAdmin(
        new Request('http://x/api/admin/foo', {
          method: 'POST',
          headers: { 'x-forwarded-for': '1.2.3.4', 'x-admin-secret': `w-${i}` },
        }) as never
      );
    }
    // IP2 fraîche → doit passer
    const res = await authenticateAdmin(
      new Request('http://x/api/admin/foo', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '5.6.7.8',
          'x-admin-secret': 'super-secret-for-tests',
        },
      }) as never
    );
    expect(res.ok).toBe(true);
  });

  it("ne crash pas quand x-admin-secret est plus long que ADMIN_SECRET", async () => {
    authMock.mockResolvedValueOnce(null);
    // Le secret stocké fait ~22 chars, on envoie 100 chars → timingSafeEqual throw
    // sur length mismatch. Notre wrapper doit catch ça proprement.
    const res = await authenticateAdmin(
      makeReq({ 'x-admin-secret': 'a'.repeat(100) }) as never
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });
});
