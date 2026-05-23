/**
 * Tests d'intégration GET /api/users/by-email (Discovery cross-app).
 *
 * Couvre tous les cas demandés par le brief :
 *   - user inconnu → 200 {exists:false, tenants:[]}
 *   - user mono-app → 200 {exists:true, tenants:[{app,role}]}
 *   - user multi-app → 200 + 2 entrées
 *   - HMAC invalide → 401
 *   - rate-limit IP dépassé → 429
 *   - rate-limit app dépassé → 429
 *   - query malformée → 400 (email absent, email pas un email, > 254 chars)
 *   - secret pas configuré → 503
 *   - Cache-Control: no-store toujours présent
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';

const SECRET = 'test-secret-notifuse-discovery';

const usersDb: Array<{ id: string; email: string; supabaseUserId: string | null }> = [];
const tenantsDb: Array<{
  id: string;
  userId: string;
  notifuseWorkspaceSlug: string | null;
  prospectionApiKey: string | null;
  deletedAt: Date | null;
}> = [];
const membersDb: Array<{
  tenantId: string;
  userId: string;
  role: string;
  deletedAt: Date | null;
}> = [];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const u = usersDb.find((u) => u.email === where.email);
        if (!u) return null;
        const out: any = {};
        for (const k of Object.keys(select ?? {})) out[k] = (u as any)[k];
        return out;
      }),
      findFirst: vi.fn(async ({ where, select }: any) => {
        const target =
          typeof where.email === 'string'
            ? where.email.toLowerCase()
            : where.email?.equals?.toLowerCase();
        const u = usersDb.find((u) => u.email.toLowerCase() === target);
        if (!u) return null;
        const out: any = {};
        for (const k of Object.keys(select ?? {})) out[k] = (u as any)[k];
        return out;
      }),
    },
    tenant: {
      findMany: vi.fn(async ({ where, select }: any) => {
        const filtered = tenantsDb.filter((t) => {
          if (where.deletedAt === null && t.deletedAt !== null) return false;
          if (where.userId && t.userId !== where.userId) return false;
          if (where.id?.in && !where.id.in.includes(t.id)) return false;
          return true;
        });
        return filtered.map((t) => {
          const out: any = {};
          for (const k of Object.keys(select ?? {})) out[k] = (t as any)[k];
          return out;
        });
      }),
    },
    tenantMember: {
      findMany: vi.fn(async ({ where, select }: any) => {
        const filtered = membersDb.filter((m) => {
          if (where.deletedAt === null && m.deletedAt !== null) return false;
          if (where.userId && m.userId !== where.userId) return false;
          return true;
        });
        return filtered.map((m) => {
          const out: any = {};
          for (const k of Object.keys(select ?? {})) out[k] = (m as any)[k];
          return out;
        });
      }),
    },
  },
}));

let ipCounter = 0;

function signGet(opts: {
  app: string;
  email: string;
  secret?: string;
  timestamp?: string;
  ipOverride?: string;
  url?: string;
  extraQuery?: Record<string, string>;
  /**
   * Si défini, ajoute `x-veridian-e2e-bypass-ratelimit` — utilisé pour
   * tester l'intégration enforceWithBypass sur les deux limiters discovery.
   */
  rateLimitBypass?: string;
}): { url: string; headers: Headers } {
  ipCounter += 1;
  const ts = opts.timestamp ?? String(Date.now());
  const baseUrl = opts.url ?? 'https://hub.veridian.site/api/users/by-email';
  const params = new URLSearchParams();
  params.set('email', opts.email);
  for (const [k, v] of Object.entries(opts.extraQuery ?? {})) params.set(k, v);
  const url = `${baseUrl}?${params.toString()}`;

  const parsed = new URL(url);
  const entries: Array<[string, string]> = [];
  parsed.searchParams.forEach((v, k) => entries.push([k, v]));
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const sortedQs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const canonicalPath = sortedQs.length > 0 ? `${parsed.pathname}?${sortedQs}` : parsed.pathname;
  const canonical = `${ts}.GET.${canonicalPath}`;
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(canonical).digest('hex');

  const headers = new Headers({
    'x-forwarded-for': opts.ipOverride ?? `10.0.0.${ipCounter}`,
    'x-veridian-app': opts.app,
    'x-veridian-timestamp': ts,
    'x-veridian-hub-signature': sig,
  });
  if (opts.rateLimitBypass) {
    headers.set('x-veridian-e2e-bypass-ratelimit', opts.rateLimitBypass);
  }
  return { url, headers };
}

function buildReq(url: string, headers: Headers): any {
  return {
    url,
    method: 'GET',
    headers,
  };
}

async function callRoute(req: any) {
  const { GET } = await import('@/app/api/users/by-email/route');
  return GET(req);
}

beforeEach(async () => {
  vi.clearAllMocks();
  usersDb.length = 0;
  tenantsDb.length = 0;
  membersDb.length = 0;
  ipCounter = 0;

  process.env.NOTIFUSE_HUB_API_SECRET = SECRET;
  process.env.PROSPECTION_HUB_API_SECRET = 'prospection-secret-different';
  delete process.env.ANALYTICS_HUB_API_SECRET;
  delete process.env.CMS_HUB_API_SECRET;

  const { discoveryAppLimiter, discoveryPreVerifyLimiter } = await import(
    '@/lib/auth/rate-limit'
  );
  discoveryAppLimiter.reset();
  discoveryPreVerifyLimiter.reset();
});

describe('GET /api/users/by-email', () => {
  it('returns 200 {exists:false, tenants:[]} for unknown email', async () => {
    const { url, headers } = signGet({ app: 'notifuse', email: 'ghost@example.com' });
    const res = await callRoute(buildReq(url, headers));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ exists: false, tenants: [] });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 200 with single tenant for mono-app user (owner Notifuse)', async () => {
    usersDb.push({
      id: 'u1',
      email: 'alice@example.com',
      supabaseUserId: '00000000-0000-0000-0000-000000000001',
    });
    tenantsDb.push({
      id: 't1',
      userId: '00000000-0000-0000-0000-000000000001',
      notifuseWorkspaceSlug: 'alice-ws',
      prospectionApiKey: null,
      deletedAt: null,
    });
    const { url, headers } = signGet({ app: 'notifuse', email: 'alice@example.com' });
    const res = await callRoute(buildReq(url, headers));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      exists: true,
      tenants: [{ app: 'notifuse', role: 'owner' }],
    });
  });

  it('returns 200 with 2 tenants for multi-app user', async () => {
    usersDb.push({
      id: 'u1',
      email: 'carol@example.com',
      supabaseUserId: '00000000-0000-0000-0000-000000000003',
    });
    tenantsDb.push({
      id: 't1',
      userId: '00000000-0000-0000-0000-000000000003',
      notifuseWorkspaceSlug: 'carol-ws',
      prospectionApiKey: 'sk_carol',
      deletedAt: null,
    });
    const { url, headers } = signGet({ app: 'notifuse', email: 'carol@example.com' });
    const res = await callRoute(buildReq(url, headers));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.exists).toBe(true);
    expect(json.tenants).toHaveLength(2);
    expect(json.tenants).toContainEqual({ app: 'notifuse', role: 'owner' });
    expect(json.tenants).toContainEqual({ app: 'prospection', role: 'owner' });
  });

  it('returns 401 on invalid HMAC signature', async () => {
    const ts = String(Date.now());
    const url =
      'https://hub.veridian.site/api/users/by-email?email=alice%40example.com';
    const headers = new Headers({
      'x-forwarded-for': '10.0.0.50',
      'x-veridian-app': 'notifuse',
      'x-veridian-timestamp': ts,
      'x-veridian-hub-signature': 'a'.repeat(64),
    });
    const res = await callRoute(buildReq(url, headers));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('unauthorized');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 503 when secret not configured for app', async () => {
    const { url, headers } = signGet({
      app: 'cms',
      email: 'x@example.com',
      secret: 'unused', // 503 levé sur env miss avant timing-safe-compare
    });
    const res = await callRoute(buildReq(url, headers));
    expect(res.status).toBe(503);
  });

  it('returns 400 on missing email query param', async () => {
    const ts = String(Date.now());
    const url = 'https://hub.veridian.site/api/users/by-email';
    const canonical = `${ts}.GET./api/users/by-email`;
    const sig = createHmac('sha256', SECRET).update(canonical).digest('hex');
    const headers = new Headers({
      'x-forwarded-for': '10.0.0.60',
      'x-veridian-app': 'notifuse',
      'x-veridian-timestamp': ts,
      'x-veridian-hub-signature': sig,
    });
    const res = await callRoute(buildReq(url, headers));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_query');
  });

  it('returns 400 on malformed email', async () => {
    const { url, headers } = signGet({ app: 'notifuse', email: 'not-an-email' });
    const res = await callRoute(buildReq(url, headers));
    expect(res.status).toBe(400);
  });

  it('returns 400 on email > 254 chars', async () => {
    const longLocal = 'a'.repeat(245);
    const longEmail = `${longLocal}@b.c`; // > 254
    const { url, headers } = signGet({ app: 'notifuse', email: longEmail });
    const res = await callRoute(buildReq(url, headers));
    expect(res.status).toBe(400);
  });

  it('returns 429 when pre-verify IP rate-limit exceeded', async () => {
    // Pre-limiter capacity = 60/min. On envoie 61 hits same IP avec
    // signatures volontairement invalides (le pre-rate limit s'applique
    // AVANT le HMAC, donc même les requêtes invalides comptent — protège
    // contre flood pré-CPU).
    const sharedIp = '10.0.0.99';
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      const ts = String(Date.now());
      const url =
        'https://hub.veridian.site/api/users/by-email?email=alice%40example.com';
      const headers = new Headers({
        'x-forwarded-for': sharedIp,
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': ts,
        'x-veridian-hub-signature': 'a'.repeat(64),
      });
      const res = await callRoute(buildReq(url, headers));
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('returns 429 when per-app rate-limit exceeded (post-HMAC)', async () => {
    usersDb.push({
      id: 'u1',
      email: 'ratey@example.com',
      supabaseUserId: '00000000-0000-0000-0000-0000000000aa',
    });
    // app-limiter capacity = 30/min, varying IPs to bypass pre-limiter.
    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const { url, headers } = signGet({
        app: 'notifuse',
        email: 'ratey@example.com',
        ipOverride: `10.1.0.${i}`,
      });
      const res = await callRoute(buildReq(url, headers));
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('per-app rate-limit isolation: notifuse exhaust does not affect prospection', async () => {
    usersDb.push({
      id: 'u1',
      email: 'iso@example.com',
      supabaseUserId: '00000000-0000-0000-0000-0000000000bb',
    });
    // Burn notifuse quota
    for (let i = 0; i < 31; i++) {
      const { url, headers } = signGet({
        app: 'notifuse',
        email: 'iso@example.com',
        ipOverride: `10.2.0.${i}`,
      });
      await callRoute(buildReq(url, headers));
    }
    // Prospection should still be allowed
    const { url, headers } = signGet({
      app: 'prospection',
      email: 'iso@example.com',
      secret: 'prospection-secret-different',
      ipOverride: '10.3.0.1',
    });
    const res = await callRoute(buildReq(url, headers));
    expect(res.status).toBe(200);
  });

  it('signature stable when query params reordered (canonical sort)', async () => {
    usersDb.push({
      id: 'u1',
      email: 'reorder@example.com',
      supabaseUserId: '00000000-0000-0000-0000-0000000000cc',
    });
    // Sign with canonical (sorted) order
    const ts = String(Date.now());
    const canonical = `${ts}.GET./api/users/by-email?email=reorder%40example.com&trace=t1`;
    const sig = createHmac('sha256', SECRET).update(canonical).digest('hex');
    // Caller sends with reversed order
    const url =
      'https://hub.veridian.site/api/users/by-email?trace=t1&email=reorder%40example.com';
    const headers = new Headers({
      'x-forwarded-for': '10.4.0.1',
      'x-veridian-app': 'notifuse',
      'x-veridian-timestamp': ts,
      'x-veridian-hub-signature': sig,
    });
    const res = await callRoute(buildReq(url, headers));
    expect(res.status).toBe(200);
  });

  it('does not leak existence between known and unknown emails (same shape)', async () => {
    usersDb.push({
      id: 'u1',
      email: 'known@example.com',
      supabaseUserId: '00000000-0000-0000-0000-0000000000dd',
    });
    const { url: u1, headers: h1 } = signGet({
      app: 'notifuse',
      email: 'unknown@example.com',
    });
    const { url: u2, headers: h2 } = signGet({
      app: 'notifuse',
      email: 'known@example.com',
    });
    const r1 = await callRoute(buildReq(u1, h1));
    const r2 = await callRoute(buildReq(u2, h2));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const j1 = await r1.json();
    const j2 = await r2.json();
    expect(Object.keys(j1).sort()).toEqual(Object.keys(j2).sort());
    expect(j1.tenants).toEqual([]);
    expect(j2.exists).toBe(true);
  });

  it('member of someone elses workspace appears as member role', async () => {
    const inviteeUuid = '00000000-0000-0000-0000-0000000000ee';
    usersDb.push({
      id: 'u_invitee',
      email: 'invitee@example.com',
      supabaseUserId: inviteeUuid,
    });
    tenantsDb.push({
      id: 't_other',
      userId: '00000000-0000-0000-0000-0000000000ff',
      notifuseWorkspaceSlug: 'other-ws',
      prospectionApiKey: null,
      deletedAt: null,
    });
    membersDb.push({
      tenantId: 't_other',
      userId: inviteeUuid,
      role: 'admin',
      deletedAt: null,
    });
    const { url, headers } = signGet({
      app: 'notifuse',
      email: 'invitee@example.com',
    });
    const res = await callRoute(buildReq(url, headers));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tenants).toEqual([{ app: 'notifuse', role: 'admin' }]);
  });
});

// ─── Bypass E2E rate-limit (passage à enforceWithBypass) ─────────────────
// GET /api/users/by-email utilise désormais
// `discoveryPreVerifyLimiter.enforceWithBypass(ip, headers)` ET
// `discoveryAppLimiter.enforceWithBypass(app, headers)` — les 2 couches
// (pré-HMAC IP + post-HMAC app) bypassent ensemble en staging.
describe('GET /api/users/by-email — bypass E2E header', () => {
  const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
  const ORIG_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;
  const BYPASS = 'd'.repeat(48);

  beforeEach(() => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.E2E_RATELIMIT_BYPASS_SECRET = BYPASS;
  });

  afterAll(() => {
    if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
    else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
    if (ORIG_SECRET === undefined) delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_SECRET;
  });

  it('bypass header valide en staging → 80+ discovery sans 429 (2 couches)', async () => {
    usersDb.push({
      id: 'u1',
      email: 'bypassed@example.com',
      supabaseUserId: '00000000-0000-0000-0000-0000000000bb',
    });
    // 80 > caps des deux limiters (60/min IP + 30/min app)
    for (let i = 0; i < 80; i++) {
      const { url, headers } = signGet({
        app: 'notifuse',
        email: 'bypassed@example.com',
        ipOverride: '10.99.0.1', // même IP pour saturer pre-limiter
        rateLimitBypass: BYPASS,
      });
      const r = await callRoute(buildReq(url, headers));
      expect(r.status, `req #${i} should bypass (got ${r.status})`).toBe(200);
    }
  });

  it('GARDE-FOU PROD : bypass header ignoré, 429 quand cap dépassé', async () => {
    process.env.DEPLOY_ENV = 'prod';
    usersDb.push({
      id: 'u2',
      email: 'prodbypass@example.com',
      supabaseUserId: '00000000-0000-0000-0000-0000000000cc',
    });
    let lastStatus = 0;
    for (let i = 0; i < 65; i++) {
      const { url, headers } = signGet({
        app: 'notifuse',
        email: 'prodbypass@example.com',
        ipOverride: '10.99.0.2',
        rateLimitBypass: BYPASS,
      });
      const r = await callRoute(buildReq(url, headers));
      lastStatus = r.status;
    }
    expect(lastStatus, 'PROD MUST ignore bypass header').toBe(429);
  });
});
