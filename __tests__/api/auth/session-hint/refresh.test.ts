/**
 * Tests POST /api/auth/session-hint/refresh — pose le cookie hint pour
 * l'utilisateur loggué.
 *
 * Couvre Mode Nuclear :
 *  - 401 sans session
 *  - 401 si session.user.email absent
 *  - 200 + cookie hint posé pour session valide
 *  - 500 si SESSION_HINT_SECRET absent (refus net, session principale OK)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));

vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => authMock(...args) }));

import { POST } from '@/app/api/auth/session-hint/refresh/route';

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/auth/session-hint/refresh', {
    method: 'POST',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SESSION_HINT_SECRET = 'x'.repeat(48);
  process.env.NODE_ENV = 'production';
  process.env.DEPLOY_ENV = 'prod';
});

describe('POST /api/auth/session-hint/refresh', () => {
  it('401 sans session', async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('401 si session sans email', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1' } });
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
  });

  it('200 + Set-Cookie veridian-session-hint pour session valide', async () => {
    authMock.mockResolvedValue({
      user: { id: 'u1', email: 'robert@veridian.site', name: 'Robert', image: null },
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('veridian-session-hint=');
    expect(setCookie).toContain('Domain=.veridian.site');
    expect(setCookie).not.toContain('HttpOnly');
  });

  it('500 si SESSION_HINT_SECRET absent (config faulty)', async () => {
    delete process.env.SESSION_HINT_SECRET;
    authMock.mockResolvedValue({
      user: { id: 'u1', email: 'a@b.com' },
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('misconfigured');
  });
});
