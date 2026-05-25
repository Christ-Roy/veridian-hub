/**
 * Tests d'intégration POST /api/mail/send-as-user.
 *
 * Couvre :
 *   - 401 invalid_hmac
 *   - 400 missing headers
 *   - 400 invalid_json
 *   - 400 invalid_payload (Zod : missing required, both body absent, etc.)
 *   - 422 provider_not_supported_v1 (provider=microsoft)
 *   - 404 user_not_found
 *   - 422 provider_not_linked
 *   - 412 needs_reauth (refresh révoqué)
 *   - 200 OK + payload
 *   - 200 idempotent_replay
 *   - 503 secret_not_configured (HMAC retour status 503)
 *   - 429 rate_limit (steady state cap 5/min/(app,user))
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';

const SECRET = 'test-secret-prospection-mail-gateway';
const ORIGINAL_ENV = { ...process.env };

// Mock send-gmail (le coeur métier est testé séparément)
const sendGmailMock = vi.fn();
vi.mock('@/lib/mail/send-gmail', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mail/send-gmail')>(
    '@/lib/mail/send-gmail',
  );
  return {
    ...actual,
    sendGmailAsUser: (...args: unknown[]) => sendGmailMock(...(args as [unknown, unknown])),
  };
});

// Stub prisma — la route v1.1 utilise prisma.mailRecipientRateLimit pour
// le rate-limit per-recipient. Par défaut renvoie [] (= aucun destinataire
// bloqué). Test override via mailRecipientRateLimitFindManyMock.
const mailRecipientRateLimitFindManyMock = vi.fn();
const mailRecipientRateLimitUpsertMock = vi.fn();
const mailRateLimitEventCreateMock = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    mailRecipientRateLimit: {
      findMany: (...args: unknown[]) => mailRecipientRateLimitFindManyMock(...args),
      upsert: (...args: unknown[]) => mailRecipientRateLimitUpsertMock(...args),
    },
    mailRateLimitEvent: {
      create: (...args: unknown[]) => mailRateLimitEventCreateMock(...args),
    },
  },
}));

import {
  mailSendAsUserLimiter,
  mailSendAsUserPreVerifyLimiter,
} from '@/lib/auth/rate-limit';
import {
  MailUserNotFoundError,
  MailProviderNotLinkedError,
  MailNeedsReauthError,
} from '@/lib/mail/send-gmail';

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.0.0.${ipCounter}`;
}

function sign(secret: string, ts: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

function makeRequest({
  app = 'prospection',
  body,
  secret = SECRET,
  drift = 0,
  ip,
  withSignatureBody,
}: {
  app?: string;
  body: string;
  secret?: string;
  drift?: number;
  ip?: string;
  /** Optionally sign a *different* body (test sig mismatch) */
  withSignatureBody?: string;
}) {
  const ts = String(Date.now() + drift);
  const sig = sign(secret, ts, withSignatureBody ?? body);
  const req = new Request('http://localhost/api/mail/send-as-user', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-veridian-app': app,
      'x-veridian-timestamp': ts,
      'x-veridian-hub-signature': sig,
      'x-forwarded-for': ip ?? freshIp(),
    },
    body,
  });
  return req;
}

const validBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    user_id: 'cuid_user_alice',
    to: 'bob@example.com',
    subject: 'Hello',
    body_text: 'World',
    idempotency_key: randomUUID(),
    contract_version: '1.0',
    ...over,
  });

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env.PROSPECTION_HUB_API_SECRET = SECRET;
  process.env.NOTIFUSE_HUB_API_SECRET = 'another-secret';
  process.env.DEPLOY_ENV = 'staging';
  mailSendAsUserLimiter.reset();
  mailSendAsUserPreVerifyLimiter.reset();
  sendGmailMock.mockReset();
  // Par défaut, aucun destinataire dans le bucket = tous OK.
  mailRecipientRateLimitFindManyMock.mockReset().mockResolvedValue([]);
  mailRecipientRateLimitUpsertMock.mockReset().mockResolvedValue({});
  mailRateLimitEventCreateMock.mockReset().mockResolvedValue({});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function callRoute(req: Request): Promise<Response> {
  // Re-import après reset modules pour que les ENV soient prises en compte
  const route = await import('@/app/api/mail/send-as-user/route');
  return route.POST(req as any);
}

describe('POST /api/mail/send-as-user — HMAC + Zod gates', () => {
  it('returns 401 on invalid signature', async () => {
    const body = validBody();
    const req = makeRequest({ body, withSignatureBody: 'tampered' });
    const res = await callRoute(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('invalid_hmac');
  });

  it('returns 400 when x-veridian-app header missing', async () => {
    const body = validBody();
    const req = new Request('http://localhost/api/mail/send-as-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body,
    });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
  });

  it('returns 503 when secret not configured', async () => {
    delete process.env.PROSPECTION_HUB_API_SECRET;
    const body = validBody();
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('secret_not_configured');
  });

  it('returns 400 invalid_json when body is not parseable', async () => {
    const ts = String(Date.now());
    const raw = '{not-json';
    const sig = sign(SECRET, ts, raw);
    const req = new Request('http://localhost/api/mail/send-as-user', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-veridian-app': 'prospection',
        'x-veridian-timestamp': ts,
        'x-veridian-hub-signature': sig,
        'x-forwarded-for': freshIp(),
      },
      body: raw,
    });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_json');
  });

  it('returns 400 invalid_payload when neither body_text nor body_html', async () => {
    const body = JSON.stringify({
      user_id: 'cuid_alice',
      to: 'bob@example.com',
      subject: 'Hi',
      idempotency_key: randomUUID(),
      contract_version: '1.0',
    });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_payload');
  });

  it('returns 400 invalid_payload when idempotency_key is not UUID', async () => {
    const body = validBody({ idempotency_key: 'not-a-uuid' });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
  });

  it('returns 422 when provider=microsoft in v1', async () => {
    const body = validBody({ provider: 'microsoft' });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('provider_not_supported_v1');
  });
});

describe('POST /api/mail/send-as-user — broker delegation', () => {
  it('returns 200 with normalized response on success', async () => {
    sendGmailMock.mockResolvedValueOnce({
      messageId: 'gmail_msg_42',
      sentAt: new Date('2026-05-25T12:00:00Z'),
      mailAccountIdUsed: 'acc_clx_default',
    });
    const body = validBody();
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message_id).toBe('gmail_msg_42');
    expect(json.provider_used).toBe('google');
    expect(json.sent_at).toBe('2026-05-25T12:00:00.000Z');
    expect(json.idempotent_replay).toBe(false);
    expect(json.mail_account_id_used).toBe('acc_clx_default');
  });

  it('passes idempotent_replay through', async () => {
    sendGmailMock.mockResolvedValueOnce({
      messageId: 'gmail_msg_replay',
      sentAt: new Date(),
      idempotentReplay: true,
      mailAccountIdUsed: 'acc_clx_default',
    });
    const body = validBody();
    const req = makeRequest({ body });
    const res = await callRoute(req);
    const json = await res.json();
    expect(json.idempotent_replay).toBe(true);
  });

  it('returns 404 user_not_found when broker throws', async () => {
    sendGmailMock.mockRejectedValueOnce(new MailUserNotFoundError('nope'));
    const body = validBody();
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('user_not_found');
  });

  it('returns 422 provider_not_linked', async () => {
    sendGmailMock.mockRejectedValueOnce(new MailProviderNotLinkedError('x'));
    const body = validBody();
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('provider_not_linked');
  });

  it('returns 412 needs_reauth', async () => {
    sendGmailMock.mockRejectedValueOnce(new MailNeedsReauthError('x'));
    const body = validBody();
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(412);
    expect((await res.json()).error).toBe('needs_reauth');
  });
});

describe('POST /api/mail/send-as-user — rate-limit', () => {
  it('returns 429 after 5 send for same (app, user) within 1 min', async () => {
    sendGmailMock.mockResolvedValue({
      messageId: 'gmail_msg',
      sentAt: new Date(),
      mailAccountIdUsed: 'acc_clx_default',
    });

    const userId = 'cuid_user_burst';
    // Le pre-verify limiter (IP) est à 60/min — on utilise des IPs uniques
    // pour ne pas le déclencher, et on vise le user-limiter (5/min).
    for (let i = 0; i < 5; i++) {
      const req = makeRequest({
        body: validBody({ user_id: userId }),
        ip: freshIp(),
      });
      const res = await callRoute(req);
      expect(res.status).toBe(200);
    }
    const req6 = makeRequest({
      body: validBody({ user_id: userId }),
      ip: freshIp(),
    });
    const res6 = await callRoute(req6);
    expect(res6.status).toBe(429);
    expect((await res6.json()).error).toBe('rate_limit');
  });
});

// ─── v1.1 — contract_version + mail_account_id ───────────────────────────────

describe('POST /api/mail/send-as-user — v1.1 contract', () => {
  it('accepts contract_version "1.1" with mail_account_id', async () => {
    sendGmailMock.mockResolvedValueOnce({
      messageId: 'gmail_msg_v11',
      sentAt: new Date(),
      mailAccountIdUsed: 'acc_clx_chosen',
    });
    const body = validBody({
      contract_version: '1.1',
      mail_account_id: 'acc_clx_chosen',
    });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mail_account_id_used).toBe('acc_clx_chosen');
    // Vérifie que le mail_account_id est bien passé au broker.
    expect(sendGmailMock).toHaveBeenCalledWith(
      'cuid_user_alice',
      expect.objectContaining({ mailAccountId: 'acc_clx_chosen' }),
    );
  });

  it('accepts contract_version "1.1" without mail_account_id (resolves default)', async () => {
    sendGmailMock.mockResolvedValueOnce({
      messageId: 'gmail_msg_auto',
      sentAt: new Date(),
      mailAccountIdUsed: 'acc_clx_resolved_default',
    });
    const body = validBody({ contract_version: '1.1' });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(200);
    expect((await res.json()).mail_account_id_used).toBe(
      'acc_clx_resolved_default',
    );
  });

  it('returns 400 when mail_account_id sent with v1.0 (caller bug)', async () => {
    const body = validBody({
      contract_version: '1.0',
      mail_account_id: 'acc_clx_xxx',
    });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_payload');
    expect(json.message).toMatch(/contract_version >= 1\.1/);
  });

  it('returns 404 account_not_found when broker throws MailAccountNotFoundError', async () => {
    const { MailAccountNotFoundError } = await import('@/lib/mail/send-gmail');
    sendGmailMock.mockRejectedValueOnce(
      new MailAccountNotFoundError('not found'),
    );
    const body = validBody({
      contract_version: '1.1',
      mail_account_id: 'acc_clx_does_not_exist',
    });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('account_not_found');
  });

  it('rejects contract_version "2.0" (unsupported)', async () => {
    const body = validBody({ contract_version: '2.0' });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_payload');
  });
});

// ─── v1.1 — rate-limit per-recipient ─────────────────────────────────────────

describe('POST /api/mail/send-as-user — rate-limit per-recipient', () => {
  it('returns 429 rate_limit_recipient when sole recipient is throttled', async () => {
    const now = Date.now();
    // Simule : bob@example.com a reçu un mail il y a 5 minutes (300s).
    // window = 20min (1200s). retry_after attendu ≈ 1200 - 300 = 900s.
    mailRecipientRateLimitFindManyMock.mockResolvedValueOnce([
      {
        recipientEmail: 'bob@example.com',
        lastSentAt: new Date(now - 5 * 60_000),
      },
    ]);
    const body = validBody({ to: 'bob@example.com' });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe('rate_limit_recipient');
    expect(json.recipient).toBe('bob@example.com');
    expect(json.retry_after_seconds).toBeGreaterThan(800);
    expect(json.retry_after_seconds).toBeLessThanOrEqual(900);
    // Vérifie que sendGmail n'a PAS été appelé.
    expect(sendGmailMock).not.toHaveBeenCalled();
  });

  it('returns 207 multi-status when some recipients OK / some blocked', async () => {
    const now = Date.now();
    mailRecipientRateLimitFindManyMock.mockResolvedValueOnce([
      // Seul 'spam@example.com' est dans le bucket.
      {
        recipientEmail: 'spam@example.com',
        lastSentAt: new Date(now - 10_000),
      },
    ]);
    sendGmailMock.mockResolvedValueOnce({
      messageId: 'gmail_msg_partial',
      sentAt: new Date(),
      mailAccountIdUsed: 'acc_clx_default',
    });
    const body = validBody({
      to: ['ok1@example.com', 'spam@example.com', 'ok2@example.com'],
    });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(207);
    const json = await res.json();
    expect(json.sent).toContain('ok1@example.com');
    expect(json.sent).toContain('ok2@example.com');
    expect(json.sent).not.toContain('spam@example.com');
    expect(json.rate_limited).toHaveLength(1);
    expect(json.rate_limited[0].email).toBe('spam@example.com');
    // Le broker a été appelé avec seulement les destinataires OK.
    expect(sendGmailMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        to: expect.arrayContaining(['ok1@example.com', 'ok2@example.com']),
      }),
    );
  });

  it('does NOT rate-limit cc/bcc (only to[])', async () => {
    const now = Date.now();
    // Le bucket a 'cc-spam@x.com' mais c'est dans cc — pas dans to.
    mailRecipientRateLimitFindManyMock.mockResolvedValueOnce([]);
    sendGmailMock.mockResolvedValueOnce({
      messageId: 'gmail_msg_cc',
      sentAt: new Date(),
      mailAccountIdUsed: 'acc_clx_default',
    });
    const body = validBody({
      to: 'fresh-recipient@example.com',
      cc: ['cc-spam@example.com'],
      bcc: ['bcc-spam@example.com'],
    });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(200);
    // Le findMany ne doit avoir été appelé qu'avec les emails du to, pas cc/bcc.
    expect(mailRecipientRateLimitFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { recipientEmail: { in: ['fresh-recipient@example.com'] } },
      }),
    );
  });

  it('normalizes email case in bucket lookup (anti-bypass)', async () => {
    const now = Date.now();
    // Bucket contient l'email lowercase.
    mailRecipientRateLimitFindManyMock.mockResolvedValueOnce([
      { recipientEmail: 'mixed@example.com', lastSentAt: new Date(now - 1000) },
    ]);
    // Le caller envoie en MIXED-CASE → doit être bloqué.
    const body = validBody({ to: 'MIXED@Example.com' });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(429);
  });

  it('records sent recipients after successful send (upsert called)', async () => {
    sendGmailMock.mockResolvedValueOnce({
      messageId: 'gmail_msg_record',
      sentAt: new Date(),
      mailAccountIdUsed: 'acc_clx_default',
    });
    const body = validBody({ to: ['a@example.com', 'b@example.com'] });
    const req = makeRequest({ body });
    const res = await callRoute(req);
    expect(res.status).toBe(200);
    // 2 destinataires → 2 upserts.
    expect(mailRecipientRateLimitUpsertMock).toHaveBeenCalledTimes(2);
  });

  it('logs block in mail_rate_limit_events for forensics', async () => {
    const now = Date.now();
    mailRecipientRateLimitFindManyMock.mockResolvedValueOnce([
      { recipientEmail: 'spam@x.com', lastSentAt: new Date(now - 1000) },
    ]);
    const body = validBody({ to: 'spam@x.com' });
    const req = makeRequest({ body });
    await callRoute(req);
    // Best-effort fire-and-forget; on attend 0ms.
    await new Promise((r) => setTimeout(r, 0));
    expect(mailRateLimitEventCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recipientEmail: 'spam@x.com',
          appCaller: 'prospection',
        }),
      }),
    );
  });

  it('bypass header skips rate-limit per-recipient when secret valid + non-prod', async () => {
    const BYPASS_SECRET = 'mail-rate-bypass-secret-at-least-32-characters-long-ok';
    process.env.MAIL_RATE_LIMIT_BYPASS_SECRET = BYPASS_SECRET;
    process.env.DEPLOY_ENV = 'staging';
    sendGmailMock.mockResolvedValueOnce({
      messageId: 'gmail_msg_bypass',
      sentAt: new Date(),
      mailAccountIdUsed: 'acc_clx_default',
    });

    // Même si le bucket dit "bloqué", le bypass passe.
    mailRecipientRateLimitFindManyMock.mockResolvedValueOnce([
      { recipientEmail: 'spam@x.com', lastSentAt: new Date() },
    ]);

    const body = validBody({ to: 'spam@x.com' });
    const ts = String(Date.now());
    const sig = sign(SECRET, ts, body);
    const req = new Request('http://localhost/api/mail/send-as-user', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-veridian-app': 'prospection',
        'x-veridian-timestamp': ts,
        'x-veridian-hub-signature': sig,
        'x-veridian-bypass-rate-limit': BYPASS_SECRET,
        'x-forwarded-for': freshIp(),
      },
      body,
    });
    const res = await callRoute(req);
    expect(res.status).toBe(200);
  });

  it('bypass header DOES NOT work in prod (sec defense)', async () => {
    const BYPASS_SECRET = 'mail-rate-bypass-secret-at-least-32-characters-long-ok';
    process.env.MAIL_RATE_LIMIT_BYPASS_SECRET = BYPASS_SECRET;
    process.env.DEPLOY_ENV = 'prod';

    mailRecipientRateLimitFindManyMock.mockResolvedValueOnce([
      { recipientEmail: 'spam@x.com', lastSentAt: new Date() },
    ]);

    const body = validBody({ to: 'spam@x.com' });
    const ts = String(Date.now());
    const sig = sign(SECRET, ts, body);
    const req = new Request('http://localhost/api/mail/send-as-user', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-veridian-app': 'prospection',
        'x-veridian-timestamp': ts,
        'x-veridian-hub-signature': sig,
        'x-veridian-bypass-rate-limit': BYPASS_SECRET,
        'x-forwarded-for': freshIp(),
      },
      body,
    });
    const res = await callRoute(req);
    expect(res.status).toBe(429); // pas de bypass en prod
  });
});
