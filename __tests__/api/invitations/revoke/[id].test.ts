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

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
function makeReq(opts: { ip?: string } = {}) {
  ipCounter += 1;
  return {
    headers: new Headers({
      'x-forwarded-for': opts.ip ?? `10.3.0.${ipCounter}`,
    }),
  } as any;
}

async function callRoute(id: string, req: any) {
  const { POST } = await import('@/app/api/invitations/revoke/[id]/route');
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(async () => {
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
    expiresAt: new Date(Date.now() - 60_000),
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
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    acceptedAt: new Date(Date.now() - 60_000),
    acceptedByUserId: 'user_charlie',
  });

  sessionUser = { id: 'user_owner', email: 'owner@example.com' };
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
});
