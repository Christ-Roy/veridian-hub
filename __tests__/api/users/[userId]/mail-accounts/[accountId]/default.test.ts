/**
 * Tests d'intégration POST /api/users/{userId}/mail-accounts/{accountId}/default.
 *
 * Couvre :
 *   - 401 invalid_hmac
 *   - 503 secret_not_configured
 *   - 404 user_not_found
 *   - 404 account_not_found (Account inexistant OU pas au user demandé)
 *   - 400 account_not_eligible_for_mail (pas de gmail.send scope)
 *   - 200 transaction (reset autres + set celui-ci)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const SECRET = 'test-secret-notifuse-default-account';
const ORIGINAL_ENV = { ...process.env };

const userFindUniqueMock = vi.fn();
const accountFindUniqueMock = vi.fn();
const accountUpdateManyMock = vi.fn();
const accountUpdateMock = vi.fn();
const transactionMock = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => userFindUniqueMock(...args),
    },
    account: {
      findUnique: (...args: unknown[]) => accountFindUniqueMock(...args),
      updateMany: (...args: unknown[]) => accountUpdateManyMock(...args),
      update: (...args: unknown[]) => accountUpdateMock(...args),
    },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}));

import {
  mailSendAsUserPreVerifyLimiter,
} from '@/lib/auth/rate-limit';

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.0.2.${ipCounter}`;
}

function sign(secret: string, ts: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

function makeRequest({
  userId = 'cuid_alice',
  accountId = 'acc_clx_target',
  app = 'notifuse',
  secret = SECRET,
  withSignatureBody,
}: {
  userId?: string;
  accountId?: string;
  app?: string;
  secret?: string;
  withSignatureBody?: string;
} = {}) {
  const ts = String(Date.now());
  const sig = sign(secret, ts, withSignatureBody ?? '');
  const req = new Request(
    `http://localhost/api/users/${userId}/mail-accounts/${accountId}/default`,
    {
      method: 'POST',
      headers: {
        'x-veridian-app': app,
        'x-veridian-timestamp': ts,
        'x-veridian-hub-signature': sig,
        'x-forwarded-for': freshIp(),
      },
    },
  );
  return { req, userId, accountId };
}

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env.NOTIFUSE_HUB_API_SECRET = SECRET;
  process.env.DEPLOY_ENV = 'staging';
  mailSendAsUserPreVerifyLimiter.reset();
  userFindUniqueMock.mockReset();
  accountFindUniqueMock.mockReset();
  accountUpdateManyMock.mockReset();
  accountUpdateMock.mockReset();
  transactionMock.mockReset().mockResolvedValue([{}, {}]);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function callRoute(
  req: Request,
  userId: string,
  accountId: string,
): Promise<Response> {
  const route = await import(
    '@/app/api/users/[userId]/mail-accounts/[accountId]/default/route'
  );
  return route.POST(req as any, {
    params: Promise.resolve({ userId, accountId }),
  });
}

describe('POST mail-accounts/default — gates', () => {
  it('returns 401 on invalid signature', async () => {
    const { req, userId, accountId } = makeRequest({
      withSignatureBody: 'tampered',
    });
    const res = await callRoute(req, userId, accountId);
    expect(res.status).toBe(401);
  });

  it('returns 503 when secret not configured', async () => {
    delete process.env.NOTIFUSE_HUB_API_SECRET;
    const { req, userId, accountId } = makeRequest();
    const res = await callRoute(req, userId, accountId);
    expect(res.status).toBe(503);
  });

  it('returns 404 user_not_found when user inconnu', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);
    const { req, userId, accountId } = makeRequest();
    const res = await callRoute(req, userId, accountId);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('user_not_found');
  });

  it('returns 404 account_not_found when account does not exist', async () => {
    userFindUniqueMock.mockResolvedValueOnce({ id: 'cuid_alice' });
    accountFindUniqueMock.mockResolvedValueOnce(null);
    const { req, userId, accountId } = makeRequest();
    const res = await callRoute(req, userId, accountId);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('account_not_found');
  });

  it('returns 404 account_not_found when account belongs to another user (sec)', async () => {
    userFindUniqueMock.mockResolvedValueOnce({ id: 'cuid_alice' });
    // Account exists but userId is different — must NOT leak as 403.
    accountFindUniqueMock.mockResolvedValueOnce({
      id: 'acc_clx_target',
      userId: 'cuid_bob',
      mailSendScope: 'gmail.send',
    });
    const { req, userId, accountId } = makeRequest();
    const res = await callRoute(req, userId, accountId);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('account_not_found');
  });

  it('returns 400 account_not_eligible_for_mail without gmail.send', async () => {
    userFindUniqueMock.mockResolvedValueOnce({ id: 'cuid_alice' });
    accountFindUniqueMock.mockResolvedValueOnce({
      id: 'acc_clx_target',
      userId: 'cuid_alice',
      mailSendScope: 'openid email profile',
    });
    const { req, userId, accountId } = makeRequest();
    const res = await callRoute(req, userId, accountId);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('account_not_eligible_for_mail');
  });
});

describe('POST mail-accounts/default — happy path', () => {
  it('returns 200 with the new default + executes transaction', async () => {
    userFindUniqueMock.mockResolvedValueOnce({ id: 'cuid_alice' });
    accountFindUniqueMock.mockResolvedValueOnce({
      id: 'acc_clx_target',
      userId: 'cuid_alice',
      mailSendScope:
        'openid email profile https://www.googleapis.com/auth/gmail.send',
    });
    const { req, userId, accountId } = makeRequest();
    const res = await callRoute(req, userId, accountId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user_id).toBe(userId);
    expect(json.account_id).toBe(accountId);
    expect(json.is_default).toBe(true);
    // Transaction appelée
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});
