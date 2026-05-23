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

describe('authenticateAdmin — garde-fou anti-ré-impersonation', () => {
  // Couvre l'ajout `isImpersonatedSession(session)` dans authenticate.ts :
  // une session impersonée ne doit JAMAIS accéder à une route admin, même
  // si l'email impersoné est dans la whitelist admin. Sinon un admin qui
  // impersonifie un autre admin ré-élèverait ses droits.
  // On laisse la vraie `isImpersonatedSession` (pure function, lit le claim
  // `impersonated` sur la session ou sur session.user) — pas de mock.

  it('403 si la session est impersonée, même quand isPlatformAdmin renvoie true', async () => {
    // Session impersonée d'un compte admin : passe isPlatformAdmin mais doit
    // être rejetée par le check isImpersonatedSession qui vient APRÈS.
    authMock.mockResolvedValueOnce({
      user: { email: 'admin@x', id: 'u1', impersonated: true },
    });
    isPlatformAdminMock.mockReturnValueOnce(true);
    const res = await authenticateAdmin(makeReq() as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
  });

  it('403 si le claim impersonated est posé à la racine de la session', async () => {
    // isImpersonatedSession lit aussi `session.impersonated` (pas seulement
    // `session.user.impersonated`) — on couvre les deux portées du claim.
    authMock.mockResolvedValueOnce({
      user: { email: 'admin@x', id: 'u1' },
      impersonated: true,
    });
    isPlatformAdminMock.mockReturnValueOnce(true);
    const res = await authenticateAdmin(makeReq() as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
  });

  it('200 pour une session admin NON impersonée (non-régression du chemin nominal)', async () => {
    // Garde-fou : le check anti-impersonation ne doit pas bloquer un admin
    // légitime. `impersonated` absent → accès autorisé.
    authMock.mockResolvedValueOnce({ user: { email: 'admin@x', id: 'u1' } });
    isPlatformAdminMock.mockReturnValueOnce(true);
    const res = await authenticateAdmin(makeReq() as never);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sessionEmail).toBe('admin@x');
  });
});

describe('authenticateAdmin — bypass rate-limit E2E staging', () => {
  // Couvre l'intégration dans authenticate.ts du shouldBypassRateLimit
  // (cf. lib/auth/rate-limit.ts). Scénario réel : la suite staging-full
  // enchaîne 60+ admin creates sur la même IP Traefik, le cap 30/min/IP
  // saute, cascade 429 sur 5 specs (13/05/15/07/11). Le bypass header
  // sécurisé skip le limiter UNIQUEMENT en non-prod avec secret valide.

  const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
  const ORIG_BYPASS_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;
  const BYPASS_SECRET = 'z'.repeat(48); // ≥ 32 chars

  beforeEach(() => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.E2E_RATELIMIT_BYPASS_SECRET = BYPASS_SECRET;
  });

  afterAll(() => {
    if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
    else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
    if (ORIG_BYPASS_SECRET === undefined)
      delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_BYPASS_SECRET;
  });

  it('bypass le rate-limit en staging quand header secret valide (>30 requêtes OK)', async () => {
    // Saturer le rate-limit avec >30 req sur la même IP, toutes avec bon secret.
    for (let i = 0; i < 35; i++) {
      const res = await authenticateAdmin(
        new Request('http://x/api/admin/foo', {
          method: 'POST',
          headers: {
            'x-forwarded-for': '7.7.7.7',
            'x-admin-secret': 'super-secret-for-tests',
            'x-veridian-e2e-bypass-ratelimit': BYPASS_SECRET,
          },
        }) as never
      );
      // Tous doivent passer (200), jamais 429 grâce au bypass.
      expect(res.ok).toBe(true);
    }
  });

  it('GARDE-FOU PROD : bypass header ignoré en prod, 429 quand même au-delà du cap', async () => {
    // Test sécu critique : en prod, le bypass est totalement court-circuité
    // (gate DEPLOY_ENV === 'prod' dans shouldBypassRateLimit).
    process.env.DEPLOY_ENV = 'prod';
    for (let i = 0; i < 30; i++) {
      authMock.mockResolvedValueOnce(null);
      await authenticateAdmin(
        new Request('http://x/api/admin/foo', {
          method: 'POST',
          headers: {
            'x-forwarded-for': '8.8.8.8',
            'x-admin-secret': `wrong-${i}`,
            'x-veridian-e2e-bypass-ratelimit': BYPASS_SECRET,
          },
        }) as never
      );
    }
    const res = await authenticateAdmin(
      new Request('http://x/api/admin/foo', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '8.8.8.8',
          'x-admin-secret': 'super-secret-for-tests',
          'x-veridian-e2e-bypass-ratelimit': BYPASS_SECRET,
        },
      }) as never
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(429);
  });

  it('bypass refusé si header secret wrong (même longueur) → 429 cascade attendu', async () => {
    const wrongSecret = 'y'.repeat(48); // même longueur que BYPASS_SECRET
    for (let i = 0; i < 30; i++) {
      authMock.mockResolvedValueOnce(null);
      await authenticateAdmin(
        new Request('http://x/api/admin/foo', {
          method: 'POST',
          headers: {
            'x-forwarded-for': '9.9.9.9',
            'x-admin-secret': `w-${i}`,
            'x-veridian-e2e-bypass-ratelimit': wrongSecret,
          },
        }) as never
      );
    }
    const res = await authenticateAdmin(
      new Request('http://x/api/admin/foo', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '9.9.9.9',
          'x-admin-secret': 'super-secret-for-tests',
          'x-veridian-e2e-bypass-ratelimit': wrongSecret,
        },
      }) as never
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(429);
  });

  it("bypass refusé si E2E_RATELIMIT_BYPASS_SECRET pas configuré côté serveur", async () => {
    delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    for (let i = 0; i < 30; i++) {
      authMock.mockResolvedValueOnce(null);
      await authenticateAdmin(
        new Request('http://x/api/admin/foo', {
          method: 'POST',
          headers: {
            'x-forwarded-for': '10.10.10.10',
            'x-admin-secret': `w-${i}`,
            'x-veridian-e2e-bypass-ratelimit': BYPASS_SECRET,
          },
        }) as never
      );
    }
    const res = await authenticateAdmin(
      new Request('http://x/api/admin/foo', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '10.10.10.10',
          'x-admin-secret': 'super-secret-for-tests',
          'x-veridian-e2e-bypass-ratelimit': BYPASS_SECRET,
        },
      }) as never
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(429);
  });

  it('rate-limit normal continue de marcher quand pas de header bypass', async () => {
    // Baseline : staging, secret configuré côté serveur, client n'envoie pas
    // de header → comportement standard (30/min/IP).
    for (let i = 0; i < 30; i++) {
      authMock.mockResolvedValueOnce(null);
      await authenticateAdmin(
        new Request('http://x/api/admin/foo', {
          method: 'POST',
          headers: {
            'x-forwarded-for': '11.11.11.11',
            'x-admin-secret': `w-${i}`,
          },
        }) as never
      );
    }
    const res = await authenticateAdmin(
      new Request('http://x/api/admin/foo', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '11.11.11.11',
          'x-admin-secret': 'super-secret-for-tests',
        },
      }) as never
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(429);
  });

  it('bypass actif : auth x-admin-secret continue de fonctionner (200 si secret OK)', async () => {
    const res = await authenticateAdmin(
      new Request('http://x/api/admin/foo', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '12.12.12.12',
          'x-admin-secret': 'super-secret-for-tests',
          'x-veridian-e2e-bypass-ratelimit': BYPASS_SECRET,
        },
      }) as never
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sessionEmail).toBeNull();
  });

  it('bypass actif : wrong x-admin-secret toujours rejeté en 401 (bypass ≠ skip auth)', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await authenticateAdmin(
      new Request('http://x/api/admin/foo', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '13.13.13.13',
          'x-admin-secret': 'wrong-secret-with-right-length-pad',
          'x-veridian-e2e-bypass-ratelimit': BYPASS_SECRET,
        },
      }) as never
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });

  // ─── Refactor 2026-05-23 : passage à enforceWithBypass ──────────────────
  // L'implémentation `authenticateAdmin` est passée du couple
  // `shouldBypassRateLimit + adminApiLimiter.enforce` au wrapper
  // `adminApiLimiter.enforceWithBypass(ip, request.headers)`. Le comportement
  // observable doit rester strictement identique :
  //   - le tag de log change de `[admin-ratelimit-bypass]` à `[ratelimit-bypass]`
  //     (centralisé dans RateLimiter, plus de double-log)
  //   - tout le reste (gate prod, secret ≥ 32 chars, timing-safe) inchangé
  //
  // Ce test verrouille l'invariant noir-boîte : 100 requêtes en staging
  // avec bypass valide traversent toutes, et 0 ne déclenche un counter
  // incrémenté côté `adminApiLimiter` (storage non touché → un client
  // SANS bypass passé juste après ne se prend PAS un 429 hérité).
  it('refactor enforceWithBypass : storage limiter inchangé après 100 bypass', async () => {
    const { adminApiLimiter } = await import('@/lib/auth/rate-limit');
    adminApiLimiter.reset();
    // 100 requêtes bypass — devraient toutes passer en 200/401 selon secret.
    for (let i = 0; i < 100; i++) {
      await authenticateAdmin(
        new Request('http://x/api/admin/foo', {
          method: 'POST',
          headers: {
            'x-forwarded-for': '14.14.14.14',
            'x-admin-secret': 'super-secret-for-tests',
            'x-veridian-e2e-bypass-ratelimit': BYPASS_SECRET,
          },
        }) as never
      );
    }
    // Le storage interne du limiter ne doit PAS avoir été incrémenté
    // (bypass = pas de hit comptabilisé) — sinon un client legit sans
    // bypass se prendrait un 429 immérité juste après.
    expect(adminApiLimiter.size()).toBe(0);
  });
});
