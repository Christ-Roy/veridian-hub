/**
 * Tests d'intégration POST /api/invitations/revoke/[id].
 *
 * Couvre :
 *   - 401 sans session
 *   - 400 sur id format invalide
 *   - 404 sur id inconnu
 *   - 403 quand inviter ≠ session user
 *   - 409 sur invitation déjà acceptée
 *   - 200 sur révocation nominale + already_inactive=false + audit
 *   - 200 sur invitation déjà expirée + already_inactive=true (no-op)
 *   - 429 rate-limit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fixedNow = new Date('2026-05-21T13:00:00Z');

type InvRow = {
  id: string;
  inviterUserId: string;
  inviteeEmail: string;
  targetApp: string;
  targetWorkspaceId: string;
  targetRole: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
};

const invitations: InvRow[] = [];
const auditLogs: any[] = [];
let sessionUser: { id: string; email: string } | null = null;

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => (sessionUser ? { user: sessionUser } : null)),
}));

vi.mock('@/lib/prisma', () => {
  const prisma = {
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    crossAppInvitation: {
      findUnique: vi.fn(async ({ where }: any) =>
        invitations.find((i) => i.id === where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const row = invitations.find((i) => i.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        auditLogs.push(data);
        return data;
      }),
    },
  };
  return { prisma };
});

let ipCounter = 0;
function makeReq(opts: { ip?: string; rateLimitBypass?: string } = {}) {
  ipCounter += 1;
  const headers = new Headers({
    'x-forwarded-for': opts.ip ?? `10.3.0.${ipCounter}`,
  });
  if (opts.rateLimitBypass) {
    headers.set('x-veridian-e2e-bypass-ratelimit', opts.rateLimitBypass);
  }
  return { headers } as any;
}

async function callRoute(id: string, req: any) {
  const { POST } = await import('@/app/api/invitations/revoke/[id]/route');
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(async () => {
  // Horloge figée à `fixedNow`. Sans ça, le test était une bombe à
  // retardement : `inv_active.expiresAt` (fixedNow + 24h = 2026-05-22T13:00Z)
  // était comparé au `now` RÉEL par `lib/invitations/revoke.ts:65`, donc
  // l'invitation "active" devenait expirée dès le 2026-05-22 13:00 UTC
  // (already_inactive=true au lieu de false). `Date` est faké → `new Date()`
  // et `Date.now()` (rate-limiter + assertion l.173) renvoient `fixedNow`.
  vi.useFakeTimers();
  vi.setSystemTime(fixedNow);
  vi.clearAllMocks();
  invitations.length = 0;
  auditLogs.length = 0;
  const { invitationVerifyLimiter } = await import('@/lib/auth/rate-limit');
  invitationVerifyLimiter.reset();

  invitations.push({
    id: 'inv_active',
    inviterUserId: 'user_owner',
    inviteeEmail: 'alice@example.com',
    targetApp: 'prospection',
    targetWorkspaceId: 'ws_42',
    targetRole: 'member',
    expiresAt: new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000),
    acceptedAt: null,
    acceptedByUserId: null,
  });
  invitations.push({
    id: 'inv_expired',
    inviterUserId: 'user_owner',
    inviteeEmail: 'bob@example.com',
    targetApp: 'notifuse',
    targetWorkspaceId: 'ws_99',
    targetRole: 'member',
    expiresAt: new Date(fixedNow.getTime() - 60_000),
    acceptedAt: null,
    acceptedByUserId: null,
  });
  invitations.push({
    id: 'inv_accepted',
    inviterUserId: 'user_owner',
    inviteeEmail: 'charlie@example.com',
    targetApp: 'cms',
    targetWorkspaceId: 'ws_77',
    targetRole: 'admin',
    expiresAt: new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000),
    acceptedAt: new Date(fixedNow.getTime() - 60_000),
    acceptedByUserId: 'user_charlie',
  });

  sessionUser = { id: 'user_owner', email: 'owner@example.com' };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/invitations/revoke/[id]', () => {
  it('returns 401 without session', async () => {
    sessionUser = null;
    const res = await callRoute('inv_active', makeReq());
    expect(res.status).toBe(401);
  });

  it('returns 400 on malformed id', async () => {
    const res = await callRoute('../../../etc/passwd', makeReq());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_id_format');
  });

  it('returns 404 on unknown id', async () => {
    const res = await callRoute('inv_unknown', makeReq());
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('not_found');
  });

  it('returns 403 when inviter mismatch session user', async () => {
    sessionUser = { id: 'user_attacker', email: 'evil@example.com' };
    const res = await callRoute('inv_active', makeReq());
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('forbidden');
  });

  it('returns 409 on already-accepted invitation', async () => {
    const res = await callRoute('inv_accepted', makeReq());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('already_accepted');
  });

  it('returns 200 + revokes active invitation + audit log', async () => {
    const res = await callRoute('inv_active', makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.invitation_id).toBe('inv_active');
    expect(json.already_inactive).toBe(false);

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('invitation.cross_app.revoke');
    expect(auditLogs[0].actor).toBe('user:owner@example.com');
    expect((auditLogs[0].payload as any).already_inactive).toBe(false);

    // Row was actually updated
    const row = invitations.find((i) => i.id === 'inv_active')!;
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('returns 200 + already_inactive=true on already-expired invitation (no DB update)', async () => {
    const res = await callRoute('inv_expired', makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.already_inactive).toBe(true);

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('invitation.cross_app.revoke.noop');
  });

  it('returns 429 after rate-limit (30/min/IP)', async () => {
    const sharedIp = '10.3.99.99';
    for (let i = 0; i < 30; i++) {
      // tape sur l'invitation acceptée → 409, mais le limiter compte avant
      const r = await callRoute('inv_accepted', makeReq({ ip: sharedIp }));
      expect(r.status).toBe(409);
    }
    const r31 = await callRoute('inv_accepted', makeReq({ ip: sharedIp }));
    expect(r31.status).toBe(429);
  });

  // ─── Bypass E2E rate-limit (passage à enforceWithBypass) ─────────────
  // POST /api/invitations/revoke/[id] utilise désormais
  // `invitationVerifyLimiter.enforceWithBypass(ip, headers)`.
  it('bypass header valide en staging → 50+ revoke sans 429', async () => {
    const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
    const ORIG_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;
    const BYPASS = 'r'.repeat(48);
    process.env.DEPLOY_ENV = 'staging';
    process.env.E2E_RATELIMIT_BYPASS_SECRET = BYPASS;
    try {
      const sharedIp = '10.55.10.10';
      for (let i = 0; i < 50; i++) {
        const r = await callRoute(
          'inv_accepted',
          makeReq({ ip: sharedIp, rateLimitBypass: BYPASS }),
        );
        expect(r.status, `req #${i} should bypass (got ${r.status})`).not.toBe(429);
      }
    } finally {
      if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
      else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
      if (ORIG_SECRET === undefined) delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
      else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_SECRET;
    }
  });

  it('GARDE-FOU PROD : bypass header ignoré, 429 quand cap dépassé', async () => {
    const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
    const ORIG_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;
    const BYPASS = 'r'.repeat(48);
    process.env.DEPLOY_ENV = 'prod';
    process.env.E2E_RATELIMIT_BYPASS_SECRET = BYPASS;
    try {
      const sharedIp = '10.66.10.10';
      for (let i = 0; i < 30; i++) {
        const r = await callRoute(
          'inv_accepted',
          makeReq({ ip: sharedIp, rateLimitBypass: BYPASS }),
        );
        expect(r.status).toBe(409);
      }
      const blocked = await callRoute(
        'inv_accepted',
        makeReq({ ip: sharedIp, rateLimitBypass: BYPASS }),
      );
      expect(blocked.status, 'PROD MUST ignore bypass header').toBe(429);
    } finally {
      if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
      else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
      if (ORIG_SECRET === undefined) delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
      else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_SECRET;
    }
  });
});
