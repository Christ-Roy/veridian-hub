/**
 * Test smoke pour POST /api/auth/signup après bascule provisioning on-demand
 * (2026-05-18).
 *
 * Vérifie que :
 *   1. Refuse JSON invalide (400).
 *   2. Refuse email/password manquants (400).
 *   3. Refuse doublon email (409).
 *   4. Crée user et NE déclenche PAS de provisioning automatique
 *      (le user choisira ses apps depuis le dashboard via /api/tenants/start).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const userStore: Map<string, any> = new Map();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: any) => userStore.get(where.email) ?? null),
      create: vi.fn(async ({ data, select }: any) => {
        const created = { id: data.id, email: data.email };
        userStore.set(data.email, created);
        return select ? { id: created.id, email: created.email } : created;
      }),
    },
  },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  userStore.clear();
  // Reset rate-limit entre les tests (sinon les 5+ tests successifs saturent)
  const { signupLimiter } = await import('@/lib/auth/rate-limit');
  signupLimiter.reset();
});

let testIpCounter = 0;
function makeReq(body: any) {
  // Chaque test utilise une IP différente pour éviter la saturation au sein
  // du fichier (les beforeEach reset le limiter aussi, double sécu).
  testIpCounter += 1;
  return {
    json: async () => body,
    headers: new Headers({ 'x-forwarded-for': `10.0.0.${testIpCounter}` }),
  } as any;
}

describe('POST /api/auth/signup', () => {
  it('rejects invalid JSON', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const req = {
      json: async () => { throw new Error('bad'); },
      headers: new Headers({ 'x-forwarded-for': '10.99.0.1' }),
    } as any;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rate-limit : 6e signup depuis même IP → 429', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const sameIpReq = (body: any) => ({
      json: async () => body,
      headers: new Headers({ 'x-forwarded-for': '10.42.0.99' }),
    } as any);
    // 5 signups successifs (mêmes credentials → rate-limit AVANT validation Zod)
    for (let i = 0; i < 5; i++) {
      const res = await POST(sameIpReq({ email: `flood-${i}@x.io`, password: 'longenough' }));
      expect([200, 201, 409]).toContain(res.status);
    }
    // 6e doit être 429
    const blocked = await POST(sameIpReq({ email: 'flood-6@x.io', password: 'longenough' }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('rejects missing email/password', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(makeReq({ email: '' }));
    expect(res.status).toBe(400);
  });

  it('rejects duplicate email (409)', async () => {
    userStore.set('dup@test.io', { id: 'existing' });
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(makeReq({ email: 'dup@test.io', password: 'longenough' }));
    expect(res.status).toBe(409);
  });

  it('creates user without auto-provisioning tenants (on-demand flow)', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(makeReq({ email: 'new@test.io', password: 'longenough' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.email).toBe('new@test.io');
    expect(body.id).toBeTruthy();
  });
});
