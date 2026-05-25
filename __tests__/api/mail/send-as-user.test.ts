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

// Stub prisma (route ne l'utilise pas directement, mais d'autres imports peuvent)
vi.mock('@/lib/prisma', () => ({
  prisma: {},
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
  });

  it('passes idempotent_replay through', async () => {
    sendGmailMock.mockResolvedValueOnce({
      messageId: 'gmail_msg_replay',
      sentAt: new Date(),
      idempotentReplay: true,
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
