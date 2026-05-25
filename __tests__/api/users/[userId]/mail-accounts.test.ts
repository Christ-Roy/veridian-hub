/**
 * Tests d'intégration GET /api/users/{userId}/mail-accounts.
 *
 * Couvre :
 *   - 401 invalid_hmac
 *   - 400 missing headers
 *   - 503 secret_not_configured
 *   - 404 user_not_found
 *   - 200 { accounts: [] } pour user sans Gmail Client 2 connecté
 *   - 200 avec liste filtrée (only gmail.send scope)
 *   - 200 avec is_default + needs_reauth flags
 *   - Cache-Control no-store
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const SECRET = 'test-secret-notifuse-mail-accounts';
const ORIGINAL_ENV = { ...process.env };

const userFindUniqueMock = vi.fn();
const accountFindManyMock = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => userFindUniqueMock(...args),
    },
    account: {
      findMany: (...args: unknown[]) => accountFindManyMock(...args),
    },
  },
}));

import {
  mailSendAsUserPreVerifyLimiter,
} from '@/lib/auth/rate-limit';

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.0.1.${ipCounter}`;
}

function sign(secret: string, ts: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

function makeRequest({
  userId = 'cuid_alice',
  app = 'notifuse',
  secret = SECRET,
  withSignatureBody,
}: {
  userId?: string;
  app?: string;
  secret?: string;
  withSignatureBody?: string;
} = {}) {
  const ts = String(Date.now());
  const sig = sign(secret, ts, withSignatureBody ?? '');
  const req = new Request(`http://localhost/api/users/${userId}/mail-accounts`, {
    method: 'GET',
    headers: {
      'x-veridian-app': app,
      'x-veridian-timestamp': ts,
      'x-veridian-hub-signature': sig,
      'x-forwarded-for': freshIp(),
    },
  });
  return { req, userId };
}

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env.NOTIFUSE_HUB_API_SECRET = SECRET;
  process.env.PROSPECTION_HUB_API_SECRET = 'other-secret';
  process.env.DEPLOY_ENV = 'staging';
  mailSendAsUserPreVerifyLimiter.reset();
  userFindUniqueMock.mockReset();
  accountFindManyMock.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function callRoute(req: Request, userId: string): Promise<Response> {
  const route = await import('@/app/api/users/[userId]/mail-accounts/route');
  return route.GET(req as any, { params: Promise.resolve({ userId }) });
}

describe('GET /api/users/[userId]/mail-accounts — gates', () => {
  it('returns 401 on invalid signature', async () => {
    const { req, userId } = makeRequest({ withSignatureBody: 'tampered' });
    const res = await callRoute(req, userId);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid_hmac');
  });

  it('returns 400 when x-veridian-app missing', async () => {
    const ts = String(Date.now());
    const sig = sign(SECRET, ts, '');
    const req = new Request('http://localhost/api/users/cuid_alice/mail-accounts', {
      method: 'GET',
      headers: {
        'x-veridian-timestamp': ts,
        'x-veridian-hub-signature': sig,
        'x-forwarded-for': freshIp(),
      },
    });
    const res = await callRoute(req, 'cuid_alice');
    expect(res.status).toBe(400);
  });

  it('returns 503 when secret not configured', async () => {
    delete process.env.NOTIFUSE_HUB_API_SECRET;
    const { req, userId } = makeRequest();
    const res = await callRoute(req, userId);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('secret_not_configured');
  });

  it('returns 404 user_not_found when user inconnu', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);
    const { req, userId } = makeRequest({ userId: 'cuid_ghost' });
    const res = await callRoute(req, userId);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('user_not_found');
  });

  it('has Cache-Control no-store', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);
    const { req, userId } = makeRequest({ userId: 'cuid_x' });
    const res = await callRoute(req, userId);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('GET /api/users/[userId]/mail-accounts — payload', () => {
  it('returns empty accounts list when user has no gmail.send-enabled Account', async () => {
    userFindUniqueMock
      .mockResolvedValueOnce({ id: 'cuid_alice' }); // first lookup
    accountFindManyMock.mockResolvedValueOnce([
      // Sign-in basic only (pas de gmail.send)
      {
        id: 'acc_basic',
        provider: 'google',
        providerAccountId: 'sub_g',
        mailSendScope: 'openid email profile',
        mailSendNeedsReauth: false,
        isDefaultForMail: false,
      },
    ]);
    const { req, userId } = makeRequest();
    const res = await callRoute(req, userId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accounts).toEqual([]);
  });

  it('returns Account list filtered to gmail.send scope', async () => {
    userFindUniqueMock
      .mockResolvedValueOnce({ id: 'cuid_alice' })
      .mockResolvedValueOnce({
        email: 'alice@example.com',
        name: 'Alice',
        createdAt: new Date('2026-05-20T10:00:00Z'),
      });
    accountFindManyMock.mockResolvedValueOnce([
      {
        id: 'acc_clx_perso',
        provider: 'google',
        providerAccountId: 'sub_perso',
        mailSendScope:
          'openid email profile https://www.googleapis.com/auth/gmail.send',
        mailSendNeedsReauth: false,
        isDefaultForMail: true,
      },
      {
        id: 'acc_clx_basic',
        provider: 'google',
        providerAccountId: 'sub_basic',
        mailSendScope: 'openid email profile', // pas de gmail.send
        mailSendNeedsReauth: false,
        isDefaultForMail: false,
      },
      {
        id: 'acc_clx_pro',
        provider: 'google',
        providerAccountId: 'sub_pro',
        mailSendScope:
          'openid email profile https://www.googleapis.com/auth/gmail.send',
        mailSendNeedsReauth: true, // needs reauth flag
        isDefaultForMail: false,
      },
    ]);
    const { req, userId } = makeRequest();
    const res = await callRoute(req, userId);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accounts).toHaveLength(2); // basic filtered out
    expect(json.accounts[0].id).toBe('acc_clx_perso');
    expect(json.accounts[0].is_default).toBe(true);
    expect(json.accounts[0].needs_reauth).toBe(false);
    expect(json.accounts[1].id).toBe('acc_clx_pro');
    expect(json.accounts[1].needs_reauth).toBe(true);
    expect(json.accounts[1].is_default).toBe(false);
    // Email/name + connected_at exposés.
    expect(json.accounts[0].email).toBe('alice@example.com');
    expect(json.accounts[0].connected_at).toBeTruthy();
  });
});
