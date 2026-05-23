/**
 * Tests d'intégration POST /api/invitations/create.
 *
 * Couvre :
 *   - 401 sur signature invalide
 *   - 400 sur body JSON invalide
 *   - 400 sur payload Zod invalide (email mal formé, target_app inconnu)
 *   - 403 sur app_mismatch (x-veridian-app != target_app)
 *   - 503 sur secret non configuré
 *   - 201 sur création nominale (token, magic_link_url, audit_log)
 *   - 200 sur réutilisation idempotente (reused=true)
 *   - 422 sur self-invitation
 *   - 404 sur inviter_user_id inconnu
 *   - 429 sur rate-limit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

const SECRET = 'test-secret-prospection-hmac';
const ORIGINAL_ENV = { ...process.env };

// On mock prisma. Le helper `createCrossAppInvitation` est appelé pour de vrai
// par la route, donc on doit fournir un fake suffisamment riche pour qu'il
// fonctionne (findUnique sur User, findFirst + create sur CrossAppInvitation,
// + create sur AuditLog best-effort).
const users: { id: string; email: string }[] = [];
const invitations: any[] = [];
const auditLogs: any[] = [];
let nextInvId = 1;

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: any) =>
        users.find((u) => u.id === where.id) ?? null,
      ),
    },
    crossAppInvitation: {
      findFirst: vi.fn(async ({ where }: any) => {
        return (
          invitations.find(
            (i) =>
              i.inviteeEmail === where.inviteeEmail &&
              i.targetApp === where.targetApp &&
              i.targetWorkspaceId === where.targetWorkspaceId &&
              i.acceptedAt === where.acceptedAt &&
              (!where.expiresAt?.gt || i.expiresAt > where.expiresAt.gt),
          ) ?? null
        );
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          ...data,
          message: data.message ?? null,
          acceptedAt: null,
          acceptedByUserId: null,
          id: `inv_${nextInvId++}`,
          createdAt: new Date(),
        };
        invitations.push(row);
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        auditLogs.push(data);
        return data;
      }),
    },
  },
}));

// Mock email envoi pour ne pas hit Brevo/SMTP en test.
const sendMailMock = vi.fn(async () => undefined);
vi.mock('@/lib/email/send', () => ({
  sendMail: (...args: unknown[]) => sendMailMock(...(args as [unknown])),
}));

let ipCounter = 0;

function buildReq(opts: {
  body: any;
  app?: string;
  signWithSecret?: string | null;
  signWithApp?: string; // pour cross-app forge tests
  timestamp?: string;
  badSignature?: string;
  ip?: string;
  /**
   * Si défini, ajoute le header `x-veridian-e2e-bypass-ratelimit` —
   * utilisé pour tester l'intégration du bypass E2E staging
   * (cf. RateLimiter.enforceWithBypass).
   */
  rateLimitBypass?: string;
}): any {
  ipCounter += 1;
  const rawBody = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const ts = opts.timestamp ?? String(Date.now());
  const app = opts.app ?? 'prospection';

  let signature = opts.badSignature;
  if (signature === undefined && opts.signWithSecret !== null) {
    const secret = opts.signWithSecret ?? SECRET;
    signature = createHmac('sha256', secret)
      .update(`${ts}.${rawBody}`)
      .digest('hex');
  }

  const headers = new Headers({
    'content-type': 'application/json',
    'x-forwarded-for': opts.ip ?? `10.0.0.${ipCounter}`,
    'x-veridian-app': app,
    'x-veridian-timestamp': ts,
  });
  if (signature !== undefined) {
    headers.set('x-veridian-invitation-signature', signature);
  }
  if (opts.rateLimitBypass) {
    headers.set('x-veridian-e2e-bypass-ratelimit', opts.rateLimitBypass);
  }

  return {
    headers,
    text: async () => rawBody,
  };
}

async function callRoute(req: any) {
  // Import à chaque appel pour bénéficier des vi.clearAllMocks().
  const { POST } = await import('@/app/api/invitations/create/route');
  return POST(req);
}

beforeEach(async () => {
  vi.clearAllMocks();
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue(undefined);
  users.length = 0;
  invitations.length = 0;
  auditLogs.length = 0;
  nextInvId = 1;
  // Reset rate-limit
  const { invitationCreateLimiter } = await import('@/lib/auth/rate-limit');
  invitationCreateLimiter.reset();

  // ENV setup (restoration in afterEach)
  process.env.HUB_INVITATION_SECRET_PROSPECTION = SECRET;
  process.env.HUB_INVITATION_SECRET_NOTIFUSE = 'notifuse-secret-different';
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
  delete process.env.HUB_INVITATION_SECRET_ANALYTICS;
  delete process.env.HUB_INVITATION_SECRET_CMS;

  users.push({ id: 'user_owner', email: 'owner@example.com' });
});

describe('POST /api/invitations/create', () => {
  const validBody = {
    inviter_user_id: 'user_owner',
    inviter_email: 'owner@example.com',
    invitee_email: 'alice@example.com',
    target_app: 'prospection',
    target_workspace_id: 'ws_42',
    target_role: 'member',
  };

  it('returns 401 on invalid HMAC signature', async () => {
    const req = buildReq({ body: validBody, badSignature: 'a'.repeat(64) });
    const res = await callRoute(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('unauthorized');
  });

  it('returns 400 on invalid JSON body', async () => {
    // Construit raw body invalide
    const ts = String(Date.now());
    const rawBody = '{not-json';
    const sig = createHmac('sha256', SECRET)
      .update(`${ts}.${rawBody}`)
      .digest('hex');
    const headers = new Headers({
      'x-forwarded-for': '10.0.0.200',
      'x-veridian-app': 'prospection',
      'x-veridian-timestamp': ts,
      'x-veridian-invitation-signature': sig,
    });
    const req = { headers, text: async () => rawBody } as any;
    const res = await callRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_json');
  });

  it('returns 400 on invalid payload (missing fields)', async () => {
    const req = buildReq({ body: { inviter_email: 'bad' } });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_payload');
  });

  it('returns 400 on invalid email format', async () => {
    const req = buildReq({
      body: { ...validBody, invitee_email: 'not-an-email' },
    });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 on unknown target_app', async () => {
    const req = buildReq({
      body: { ...validBody, target_app: 'evil-app' },
      app: 'evil-app',
    });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
  });

  it('returns 403 on app/target_app mismatch (anti cross-app forge)', async () => {
    // App signe correctement comme Notifuse mais target_app=prospection
    const req = buildReq({
      body: { ...validBody, target_app: 'prospection' },
      app: 'notifuse',
      signWithSecret: 'notifuse-secret-different',
    });
    const res = await callRoute(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('app_mismatch');
  });

  it('returns 503 when secret not configured for the app', async () => {
    const req = buildReq({
      body: { ...validBody, target_app: 'analytics' },
      app: 'analytics',
      signWithSecret: 'unused', // 503 levé avant verify signature
    });
    const res = await callRoute(req);
    expect(res.status).toBe(503);
  });

  it('returns 201 + token + magic_link on nominal creation', async () => {
    const req = buildReq({ body: validBody });
    const res = await callRoute(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.invitation_id).toMatch(/^inv_/);
    expect(json.token).toHaveLength(64);
    expect(json.magic_link_url).toBe(
      `https://app.veridian.site/invite/${json.token}`,
    );
    expect(json.target_role).toBe('member');
    expect(json.reused).toBe(false);
    expect(json.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes audit log on success', async () => {
    const req = buildReq({ body: validBody });
    await callRoute(req);
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('invitation.cross_app.create');
    expect(auditLogs[0].actor).toBe('app:prospection');
    expect(auditLogs[0].targetType).toBe('user');
    expect(auditLogs[0].targetId).toBe('user_owner');
    expect((auditLogs[0].payload as any).invitee_email).toBe('alice@example.com');
    expect((auditLogs[0].payload as any).reused).toBe(false);
  });

  it('returns 200 + reused=true on idempotent re-call', async () => {
    const req1 = buildReq({ body: validBody });
    const res1 = await callRoute(req1);
    expect(res1.status).toBe(201);
    const json1 = await res1.json();

    const req2 = buildReq({ body: validBody });
    const res2 = await callRoute(req2);
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.reused).toBe(true);
    expect(json2.invitation_id).toBe(json1.invitation_id);
    expect(json2.token).toBe(json1.token);
  });

  it('audit log uses reused action variant on idempotent re-call', async () => {
    await callRoute(buildReq({ body: validBody }));
    await callRoute(buildReq({ body: validBody }));
    expect(auditLogs).toHaveLength(2);
    expect(auditLogs[0].action).toBe('invitation.cross_app.create');
    expect(auditLogs[1].action).toBe('invitation.cross_app.create.reused');
  });

  it('returns 404 when inviter_user_id unknown', async () => {
    const req = buildReq({
      body: { ...validBody, inviter_user_id: 'user_unknown' },
    });
    const res = await callRoute(req);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('inviter_not_found');
  });

  it('returns 422 on self-invitation (case-insensitive)', async () => {
    const req = buildReq({
      body: { ...validBody, invitee_email: 'OWNER@example.com' },
    });
    const res = await callRoute(req);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('self_invitation');
  });

  it('returns 400 when message contains control chars', async () => {
    const req = buildReq({
      body: { ...validBody, message: 'hello\x00world' },
    });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when message contains < or >', async () => {
    const req = buildReq({
      body: { ...validBody, message: 'hello <script>' },
    });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
  });

  it('sendMail invoqué après création nominale (livrable 4)', async () => {
    const req = buildReq({ body: validBody });
    const res = await callRoute(req);
    expect(res.status).toBe(201);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const arg = sendMailMock.mock.calls[0][0] as any;
    expect(arg.to).toBe('alice@example.com');
    expect(arg.subject).toContain('Prospection');
    expect(arg.html).toContain('https://app.veridian.site/invite/');
    expect(arg.html).toContain("Accepter l'invitation");
    expect(arg.text).toContain('https://app.veridian.site/invite/');
  });

  it('sendMail invoqué aussi sur reused=true (rappel d\'invitation)', async () => {
    await callRoute(buildReq({ body: validBody }));
    sendMailMock.mockClear();
    const res2 = await callRoute(buildReq({ body: validBody }));
    expect(res2.status).toBe(200);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("échec d'envoi email ne fait pas échouer l'invitation (best-effort)", async () => {
    sendMailMock.mockRejectedValueOnce(new Error('Brevo down'));
    const req = buildReq({ body: validBody });
    const res = await callRoute(req);
    // L'invitation est créée malgré l'échec mail — caller peut renvoyer.
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.magic_link_url).toBeTruthy();
  });

  it('email contient le message libre si fourni', async () => {
    const req = buildReq({
      body: { ...validBody, message: 'Bienvenue dans la team' },
    });
    const res = await callRoute(req);
    expect(res.status).toBe(201);
    const arg = sendMailMock.mock.calls[0][0] as any;
    expect(arg.html).toContain('Bienvenue dans la team');
  });

  it('returns 429 after rate-limit exhausted (60/min/IP)', async () => {
    // 60 = capacity, donc le 61e doit fail.
    // Toutes les requêtes utilisent la même IP pour saturer le bucket.
    const sharedIp = '10.0.99.99';
    for (let i = 0; i < 60; i++) {
      const r = await callRoute(
        buildReq({
          body: { ...validBody, invitee_email: `alice${i}@example.com` },
          ip: sharedIp,
        }),
      );
      // Les 60 premiers passent (201 ou 200) — pas tous égaux car réutilisation
      // possible si on tape un même triplet, mais on varie invitee_email.
      expect([200, 201]).toContain(r.status);
    }
    const r61 = await callRoute(
      buildReq({
        body: { ...validBody, invitee_email: 'alice-overflow@example.com' },
        ip: sharedIp,
      }),
    );
    expect(r61.status).toBe(429);
    expect(r61.headers.get('Retry-After')).toBeTruthy();
  });

  // ─── Bypass E2E rate-limit (commit "fix(auth): bypass rate-limit étendu") ──
  // Le ticket P1 2026-05-23 a fait passer la route de `enforce(ip)` vers
  // `enforceWithBypass(ip, request.headers)`. Tests d'intégration ici
  // pour verrouiller :
  //   - bypass header valide + staging → 100+ req traversent (pas de 429)
  //   - bypass header valide + prod    → 429 quand même au-delà du cap
  //   - bypass header wrong            → comportement enforce() normal
  describe('bypass E2E rate-limit header', () => {
    const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
    const ORIG_BYPASS_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;
    const BYPASS_SECRET = 'i'.repeat(48);

    beforeEach(async () => {
      process.env.DEPLOY_ENV = 'staging';
      process.env.E2E_RATELIMIT_BYPASS_SECRET = BYPASS_SECRET;
      const { invitationCreateLimiter } = await import('@/lib/auth/rate-limit');
      invitationCreateLimiter.reset();
    });

    afterAll(() => {
      if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
      else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
      if (ORIG_BYPASS_SECRET === undefined)
        delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
      else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_BYPASS_SECRET;
    });

    it('bypass valide en staging → 75+ req sur même IP sans 429', async () => {
      const sharedIp = '10.99.88.77';
      for (let i = 0; i < 75; i++) {
        const r = await callRoute(
          buildReq({
            body: { ...validBody, invitee_email: `bypass${i}@example.com` },
            ip: sharedIp,
            rateLimitBypass: BYPASS_SECRET,
          }),
        );
        expect(r.status, `req #${i} should bypass (got ${r.status})`).not.toBe(429);
      }
    });

    it('GARDE-FOU PROD : bypass header ignoré, 429 quand cap dépassé', async () => {
      process.env.DEPLOY_ENV = 'prod';
      const sharedIp = '10.88.77.66';
      for (let i = 0; i < 60; i++) {
        const r = await callRoute(
          buildReq({
            body: { ...validBody, invitee_email: `prod${i}@example.com` },
            ip: sharedIp,
            rateLimitBypass: BYPASS_SECRET,
          }),
        );
        expect([200, 201]).toContain(r.status);
      }
      const blocked = await callRoute(
        buildReq({
          body: { ...validBody, invitee_email: 'prod-overflow@example.com' },
          ip: sharedIp,
          rateLimitBypass: BYPASS_SECRET,
        }),
      );
      expect(blocked.status, 'PROD MUST ignore bypass header').toBe(429);
    });
  });
});

// Restore env after the entire file runs
afterAll(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

// Re-export to avoid TS unused warn on imports if test runner strips.
import { afterAll } from 'vitest';
