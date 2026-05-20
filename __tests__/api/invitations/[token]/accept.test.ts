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
 *   - 202 happy path (downstream_call=pending, redirect_url, audit log)
 *   - 202 avec email_mismatch quand allow_email_mismatch=true
 *   - 429 rate-limit
 *   - 400 invalid JSON
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  vi.clearAllMocks();
  invitations.length = 0;
  auditLogs.length = 0;
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
    expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
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
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    acceptedAt: new Date(Date.now() - 60_000),
    acceptedByUserId: 'user_other',
  });

  sessionUser = { id: 'user_alice', email: 'alice@example.com' };
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
});
