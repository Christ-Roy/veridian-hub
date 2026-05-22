/**
 * Tests d'intégration POST /api/invitations/[token]/accept.
 *
 * Couvre :
 *   - 401 sans session
 *   - 404 token format invalide
 *   - 404 token inconnu
 *   - 410 invitation expirée
 *   - 409 invitation déjà acceptée
 *   - 403 email_mismatch sans allow_email_mismatch
 *   - 200 happy path quand downstream='completed' (Phase 4b)
 *   - 202 quand downstream='pending' (endpoint downstream absent / 5xx)
 *   - 502 quand downstream='error' (workspace suspended côté app)
 *   - 200/202 avec email_mismatch quand allow_email_mismatch=true
 *   - 429 rate-limit
 *   - 400 invalid JSON
 *   - audit log contient downstream_call + downstream_http_status
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const validToken = 'a'.repeat(64);
const expiredToken = 'b'.repeat(64);
const acceptedToken = 'c'.repeat(64);

const fixedNow = new Date('2026-05-21T12:00:00Z');

type InvRow = {
  id: string;
  token: string;
  inviteeEmail: string;
  targetApp: string;
  targetWorkspaceId: string;
  targetRole: string;
  message: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
};

const invitations: InvRow[] = [];
const auditLogs: any[] = [];
let sessionUser: { id: string; email: string } | null = null;

vi.mock('@/auth', () => ({
  auth: vi.fn(async () =>
    sessionUser ? { user: sessionUser } : null,
  ),
}));

/**
 * Mock du module attach-downstream. Le résultat par défaut est `pending`
 * (endpoint_not_found) — i.e. les tests existants 4a/4b "Hub a ack mais
 * downstream n'a pas livré" gardent leurs assertions 202.
 * Les tests de Phase 4b override `attachStub` pour simuler completed/error.
 */
let attachStub: any = async () => ({
  status: 'pending',
  reason: 'endpoint_not_found',
  httpStatus: 404,
});

vi.mock('@/lib/invitations/attach-downstream', () => ({
  attachMemberDownstream: vi.fn((...args: any[]) => attachStub(...args)),
}));

vi.mock('@/lib/prisma', () => {
  const prisma = {
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    crossAppInvitation: {
      findUnique: vi.fn(async ({ where }: any) =>
        invitations.find((i) => i.token === where.token) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const row = invitations.find((i) => i.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
    },
    user: {
      // Route accept lookup le supabaseUserId du user loggué (UUID v4 bridge
      // cross-app). Par défaut on retourne un UUID valide pour ne pas
      // bloquer les tests qui ne testent pas ce path. Un test dédié override
      // ce mock pour valider le cas 409 user_not_provisioned.
      findUnique: vi.fn(async () => ({
        supabaseUserId: '11111111-1111-4111-8111-111111111111',
      })),
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
function makeReq(opts: { body?: any; ip?: string } = {}) {
  ipCounter += 1;
  const raw = opts.body === undefined ? '' : JSON.stringify(opts.body);
  return {
    headers: new Headers({
      'x-forwarded-for': opts.ip ?? `10.2.0.${ipCounter}`,
    }),
    text: async () => raw,
  } as any;
}

async function callRoute(token: string, req: any) {
  const { POST } = await import('@/app/api/invitations/[token]/accept/route');
  return POST(req, { params: Promise.resolve({ token }) });
}

beforeEach(async () => {
  // Horloge figée à `fixedNow`. Sans ça, le test était une bombe à
  // retardement : `inv_active.expiresAt` (fixedNow + 24h = 2026-05-22T12:00Z)
  // était comparé au `now` RÉEL par `lib/invitations/accept.ts:138`, donc
  // l'invitation "active" devenait expirée dès le 2026-05-22 12:00 UTC →
  // 9 tests cascadaient en 410. `Date` est faké → `new Date()` et
  // `Date.now()` (dont le rate-limiter dépend) renvoient tous `fixedNow`.
  vi.useFakeTimers();
  vi.setSystemTime(fixedNow);
  vi.clearAllMocks();
  invitations.length = 0;
  auditLogs.length = 0;
  // Reset attach stub à pending par défaut (=ancien comportement 4a)
  attachStub = async () => ({
    status: 'pending',
    reason: 'endpoint_not_found',
    httpStatus: 404,
  });
  const { invitationVerifyLimiter } = await import('@/lib/auth/rate-limit');
  invitationVerifyLimiter.reset();

  invitations.push({
    id: 'inv_active',
    token: validToken,
    inviteeEmail: 'alice@example.com',
    targetApp: 'prospection',
    targetWorkspaceId: 'ws_42',
    targetRole: 'member',
    message: null,
    expiresAt: new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000),
    acceptedAt: null,
    acceptedByUserId: null,
  });
  invitations.push({
    id: 'inv_expired',
    token: expiredToken,
    inviteeEmail: 'bob@example.com',
    targetApp: 'notifuse',
    targetWorkspaceId: 'ws_99',
    targetRole: 'member',
    message: null,
    expiresAt: new Date(fixedNow.getTime() - 24 * 60 * 60 * 1000),
    acceptedAt: null,
    acceptedByUserId: null,
  });
  invitations.push({
    id: 'inv_accepted',
    token: acceptedToken,
    inviteeEmail: 'charlie@example.com',
    targetApp: 'cms',
    targetWorkspaceId: 'ws_77',
    targetRole: 'admin',
    message: null,
    expiresAt: new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000),
    acceptedAt: new Date(fixedNow.getTime() - 60_000),
    acceptedByUserId: 'user_other',
  });

  sessionUser = { id: 'user_alice', email: 'alice@example.com' };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/invitations/[token]/accept', () => {
  it('returns 401 without session', async () => {
    sessionUser = null;
    const res = await callRoute(validToken, makeReq());
    expect(res.status).toBe(401);
  });

  it('returns 404 for malformed token (no DB hit)', async () => {
    const res = await callRoute('bad-token', makeReq());
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('invalid_token_format');
  });

  it('returns 404 for unknown token', async () => {
    const res = await callRoute('e'.repeat(64), makeReq());
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('not_found');
  });

  it('returns 410 Gone for expired invitation', async () => {
    sessionUser = { id: 'user_bob', email: 'bob@example.com' };
    const res = await callRoute(expiredToken, makeReq());
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toBe('expired');
  });

  it('returns 409 Conflict for already-accepted invitation', async () => {
    sessionUser = { id: 'user_charlie', email: 'charlie@example.com' };
    const res = await callRoute(acceptedToken, makeReq());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('already_accepted');
    expect(json.accepted_by_user_id).toBe('user_other');
  });

  it('returns 403 email_mismatch by default', async () => {
    sessionUser = { id: 'user_zoe', email: 'zoe@example.com' };
    const res = await callRoute(validToken, makeReq());
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('email_mismatch');
  });

  it('returns 202 + redirect_url on happy path', async () => {
    const res = await callRoute(validToken, makeReq());
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.invitation_id).toBe('inv_active');
    expect(json.target_app).toBe('prospection');
    expect(json.target_workspace_id).toBe('ws_42');
    expect(json.target_role).toBe('member');
    expect(json.email_mismatch).toBe(false);
    expect(json.downstream_call).toBe('pending');
    expect(json.redirect_url).toMatch(/^https:\/\/prospection\./);
  });

  it('writes audit log on success', async () => {
    await callRoute(validToken, makeReq());
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('invitation.cross_app.accept');
    expect(auditLogs[0].actor).toBe('user:alice@example.com');
    expect(auditLogs[0].targetType).toBe('user');
    expect(auditLogs[0].targetId).toBe('user_alice');
    expect((auditLogs[0].payload as any).downstream_call).toBe('pending');
    expect((auditLogs[0].payload as any).email_mismatch).toBe(false);
  });

  it('returns 202 with email_mismatch=true when allow_email_mismatch=true', async () => {
    sessionUser = { id: 'user_zoe', email: 'zoe@example.com' };
    const res = await callRoute(
      validToken,
      makeReq({ body: { allow_email_mismatch: true } }),
    );
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.email_mismatch).toBe(true);
  });

  it('returns 400 on invalid JSON body', async () => {
    const headers = new Headers({ 'x-forwarded-for': '10.2.99.1' });
    const req = { headers, text: async () => '{not-json' } as any;
    const res = await callRoute(validToken, req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_json');
  });

  it('returns 400 on invalid body shape (allow_email_mismatch non-bool)', async () => {
    const res = await callRoute(
      validToken,
      makeReq({ body: { allow_email_mismatch: 'yes' } }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_payload');
  });

  it('returns 429 after rate-limit exhausted (30/min/IP)', async () => {
    const sharedIp = '10.2.99.99';
    for (let i = 0; i < 30; i++) {
      // Use accepted token to avoid mutating state but go through the limiter
      const r = await callRoute(acceptedToken, makeReq({ ip: sharedIp }));
      // 409 already accepted, but still counts vs limiter (limiter is hit first)
      expect([409]).toContain(r.status);
    }
    const r31 = await callRoute(acceptedToken, makeReq({ ip: sharedIp }));
    expect(r31.status).toBe(429);
  });

  // ─── Phase 4b — downstream propagation ──────────────────────────────
  it('returns 200 + downstream login_url when attach-member returns completed', async () => {
    attachStub = async () => ({
      status: 'completed',
      loginUrl: 'https://prospection.app.veridian.site/magic?t=abc',
      alreadyMember: false,
      httpStatus: 201,
    });
    const res = await callRoute(validToken, makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.downstream_call).toBe('completed');
    expect(json.redirect_url).toBe(
      'https://prospection.app.veridian.site/magic?t=abc',
    );
  });

  it('returns 502 + error code when downstream returns business error', async () => {
    attachStub = async () => ({
      status: 'error',
      httpStatus: 423,
      errorCode: 'workspace_suspended',
      reason: 'workspace suspended',
    });
    const res = await callRoute(validToken, makeReq());
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.downstream_call).toBe('error');
    expect(json.error).toBe('workspace_suspended');
    expect(json.downstream_http_status).toBe(423);
  });

  it('logs downstream_call=completed + downstream_http_status to audit', async () => {
    attachStub = async () => ({
      status: 'completed',
      loginUrl: 'https://x',
      alreadyMember: false,
      httpStatus: 201,
    });
    await callRoute(validToken, makeReq());
    expect(auditLogs).toHaveLength(1);
    const payload = auditLogs[0].payload as any;
    expect(payload.downstream_call).toBe('completed');
    expect(payload.downstream_http_status).toBe(201);
  });

  it('falls back to home-page redirect when completed.loginUrl is null', async () => {
    attachStub = async () => ({
      status: 'completed',
      loginUrl: null,
      alreadyMember: false,
      httpStatus: 200,
    });
    const res = await callRoute(validToken, makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.redirect_url).toMatch(/^https:\/\/prospection\./);
  });

  it('returns 409 user_not_provisioned if user has no supabaseUserId (UUID bridge missing)', async () => {
    // Anti-régression bug E2E 2026-05-21 : si un user Hub n'a pas de
    // supabaseUserId (UUID v4 bridge cross-app), on ne PEUT PAS appeler
    // attach-member côté Notifuse/Prospection — ils crashent sur "invalid
    // input syntax for type uuid". Mieux vaut refuser 409 que tenter et
    // bloquer en pending éternel.
    const { prisma } = await import('@/lib/prisma');
    (prisma.user.findUnique as any).mockResolvedValueOnce({
      supabaseUserId: null,
    });
    const res = await callRoute(validToken, makeReq());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('user_not_provisioned');
  });

  it('passes supabaseUserId (UUID v4) as hubUserId to attach-downstream, not session user.id (cuid)', async () => {
    // Anti-régression : la route doit utiliser supabaseUserId (UUID v4) pour
    // le payload downstream, PAS user.id (cuid). Notifuse et Prospection
    // utilisent ce champ comme PK Postgres et exigent un UUID v4 valide.
    const { prisma } = await import('@/lib/prisma');
    const realUuid = '22222222-2222-4222-8222-222222222222';
    (prisma.user.findUnique as any).mockResolvedValueOnce({
      supabaseUserId: realUuid,
    });
    let capturedHubUserId: string | undefined;
    attachStub = async (input: any) => {
      capturedHubUserId = input.hubUserId;
      return { status: 'pending', reason: 'endpoint_not_found', httpStatus: 404 };
    };
    await callRoute(validToken, makeReq());
    expect(capturedHubUserId).toBe(realUuid);
    expect(capturedHubUserId).not.toBe(sessionUser?.id);
  });
});
