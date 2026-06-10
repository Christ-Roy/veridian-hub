/**
 * Test smoke pour POST /api/auth/signup après bascule provisioning on-demand
 * (2026-05-18) + auto-création workspace au signup (2026-05-21).
 *
 * Vérifie que :
 *   1. Refuse JSON invalide (400).
 *   2. Refuse email/password manquants (400).
 *   3. Refuse doublon email (409).
 *   4. Crée user et NE déclenche PAS de provisioning automatique tenants
 *      (le user choisira ses apps depuis le dashboard via /api/tenants/start).
 *   5. Provisionne un workspace par défaut + WorkspaceMember role=OWNER
 *      (régression 2026-05-21 : 23 users prod orphelins de workspace).
 *   6. Échec workspace provisioning ne casse PAS le signup (best-effort).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const userStore: Map<string, any> = new Map();
const provisionCalls: Array<{ userId: string; email: string; name?: string | null }> = [];
let provisionShouldThrow = false;

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: any) => userStore.get(where.email) ?? null),
      create: vi.fn(async ({ data, select }: any) => {
        const created = { id: data.id, email: data.email, name: data.name ?? null };
        userStore.set(data.email, created);
        return select ? { id: created.id, email: created.email, name: created.name } : created;
      }),
    },
  },
}));

vi.mock('@/lib/workspace/provision', () => ({
  provisionDefaultWorkspace: vi.fn(async (input: any) => {
    provisionCalls.push({ userId: input.userId, email: input.email, name: input.name });
    if (provisionShouldThrow) throw new Error('workspace failed');
    return { workspaceId: `ws-${input.userId}`, created: true, workspaceName: 'test workspace' };
  }),
}));

const trackGoalMock = vi.fn(async () => undefined);
vi.mock('@/lib/analytics/track-event', () => ({
  trackGoal: (...args: any[]) => trackGoalMock(...args),
  hubSessionId: (uuid: string) => `hub-${uuid}`,
}));

beforeEach(async () => {
  vi.clearAllMocks();
  userStore.clear();
  provisionCalls.length = 0;
  provisionShouldThrow = false;
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

  // ─── Bypass E2E staging via header `x-veridian-e2e-bypass-ratelimit` ─────
  // Cf. RateLimiter.enforceWithBypass + shouldBypassRateLimit dans
  // lib/auth/rate-limit.ts. Trois assertions critiques :
  //   1. En staging, le header secret valide skip le rate-limit (10+ signups
  //      depuis la même IP passent sans 429).
  //   2. GARDE-FOU PROD : le header est ignoré, 6e → 429 quand même.
  //   3. Header bidon (même longueur) → bypass refusé, comportement normal.
  describe('rate-limit bypass E2E header', () => {
    const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
    const ORIG_BYPASS_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;
    const BYPASS_SECRET = 'a'.repeat(48); // ≥ 32 chars

    beforeEach(() => {
      process.env.DEPLOY_ENV = 'staging';
      process.env.E2E_RATELIMIT_BYPASS_SECRET = BYPASS_SECRET;
    });

    // afterAll restaure les env vars du process (Vitest n'isole pas).
    // Géré par afterAll du describe parent indirectement — on restaure ici aussi.
    // (le top-level beforeEach reset déjà le signupLimiter.)

    const sameIpReqWithBypass = (body: any, secret = BYPASS_SECRET) => ({
      json: async () => body,
      headers: new Headers({
        'x-forwarded-for': '10.55.0.99',
        'x-veridian-e2e-bypass-ratelimit': secret,
      }),
    } as any);

    it('bypass valide en staging : 10+ signups depuis même IP passent sans 429', async () => {
      const { POST } = await import('@/app/api/auth/signup/route');
      for (let i = 0; i < 12; i++) {
        const res = await POST(
          sameIpReqWithBypass({ email: `bypass-${i}@x.io`, password: 'longenough' })
        );
        expect(
          [200, 201, 409],
          `signup #${i} should succeed via bypass (got ${res.status})`
        ).toContain(res.status);
      }
    });

    it('GARDE-FOU PROD : bypass header ignoré, 6e signup → 429 quand même', async () => {
      process.env.DEPLOY_ENV = 'prod';
      const { POST } = await import('@/app/api/auth/signup/route');
      for (let i = 0; i < 5; i++) {
        const res = await POST(
          sameIpReqWithBypass({ email: `prod-${i}@x.io`, password: 'longenough' })
        );
        expect([200, 201, 409]).toContain(res.status);
      }
      const blocked = await POST(
        sameIpReqWithBypass({ email: 'prod-6@x.io', password: 'longenough' })
      );
      expect(blocked.status, 'PROD MUST ignore bypass header').toBe(429);
      // Restore
      if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
      else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
    });

    it('bypass refusé si header wrong (même longueur) → 429 normal', async () => {
      const wrong = 'b'.repeat(48);
      const { POST } = await import('@/app/api/auth/signup/route');
      for (let i = 0; i < 5; i++) {
        const res = await POST(sameIpReqWithBypass({ email: `w-${i}@x.io`, password: 'longenough' }, wrong));
        expect([200, 201, 409]).toContain(res.status);
      }
      const blocked = await POST(
        sameIpReqWithBypass({ email: 'w-6@x.io', password: 'longenough' }, wrong)
      );
      expect(blocked.status).toBe(429);
      // Cleanup env
      if (ORIG_BYPASS_SECRET === undefined) delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
      else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_BYPASS_SECRET;
    });
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

  it('provisions a default workspace after user creation (2026-05-21 fix)', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(makeReq({ email: 'ws@test.io', password: 'longenough' }));
    expect(res.status).toBe(201);

    // Workspace provisioning a été appelé pour ce user neuf
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0].email).toBe('ws@test.io');
    expect(provisionCalls[0].userId).toBeTruthy();
  });

  it('workspace provisioning failure does not block signup (best-effort)', async () => {
    provisionShouldThrow = true;
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(makeReq({ email: 'wsfail@test.io', password: 'longenough' }));
    // Signup réussit quand même
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.email).toBe('wsfail@test.io');
    // Mais l'appel provisioning a bien été tenté
    expect(provisionCalls).toHaveLength(1);
  });

  it('émet le goal signup tunnel (provider=credentials, user_id=email normalisé)', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const res = await POST(makeReq({ email: 'Tunnel@Test.IO', password: 'longenough' }));
    expect(res.status).toBe(201);

    expect(trackGoalMock).toHaveBeenCalledTimes(1);
    expect(trackGoalMock).toHaveBeenCalledWith({
      userEmail: 'tunnel@test.io',
      goal: 'signup',
      sessionId: expect.stringMatching(/^hub-/),
      properties: { provider: 'credentials' },
    });
  });
});
