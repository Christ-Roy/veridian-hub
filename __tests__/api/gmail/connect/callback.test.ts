/**
 * Tests /api/gmail/connect/callback — fin du flow OAuth Mail Sender.
 *
 * Couvre :
 *   - 307 vers /login si pas de session
 *   - 400 si code OR state missing
 *   - redirect vers settings/mail?status=denied si Google retourne error
 *   - redirect vers status=invalid_state si state cookie != param
 *   - redirect vers status=email_mismatch si email Google != email Hub
 *   - redirect vers status=connected + upsert Account si OK
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sessionUser = {
  id: 'cuid_user',
  email: 'alice@example.com',
  name: 'Alice',
  image: null,
  supabaseUserId: 'uid',
};
const getCurrentUserMock = vi.fn();
vi.mock('@/lib/auth/get-user', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));

const upsertMock = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    account: { upsert: (...args: unknown[]) => upsertMock(...(args as [unknown])) },
  },
}));

const exchangeMailCodeMock = vi.fn();
vi.mock('@/lib/mail/gmail-oauth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mail/gmail-oauth')>(
    '@/lib/mail/gmail-oauth',
  );
  return {
    ...actual,
    exchangeMailCode: (...args: unknown[]) =>
      exchangeMailCodeMock(...(args as [string, string])),
  };
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env.GOOGLE_MAIL_CLIENT_ID = 'cid';
  process.env.GOOGLE_MAIL_CLIENT_SECRET = 'secret';
  getCurrentUserMock.mockReset();
  upsertMock.mockReset();
  exchangeMailCodeMock.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

import { NextRequest } from 'next/server';

function makeReq(
  query: Record<string, string>,
  cookies: Record<string, string> = {},
): NextRequest {
  const url = new URL('https://hub.staging.veridian.site/api/gmail/connect/callback');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const req = new NextRequest(url);
  for (const [k, v] of Object.entries(cookies)) req.cookies.set(k, v);
  return req;
}

async function callRoute(req: NextRequest) {
  const route = await import('@/app/api/gmail/connect/callback/route');
  return route.GET(req);
}

describe('GET /api/gmail/connect/callback', () => {
  it('redirects to /login when no session', async () => {
    getCurrentUserMock.mockResolvedValueOnce(null);
    const res = await callRoute(makeReq({}));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('returns 400 when code or state missing', async () => {
    getCurrentUserMock.mockResolvedValue(sessionUser);
    const res = await callRoute(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('redirects status=denied when Google returns error=access_denied', async () => {
    getCurrentUserMock.mockResolvedValue(sessionUser);
    const res = await callRoute(makeReq({ error: 'access_denied' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('status=denied');
  });

  it('redirects status=invalid_state when cookie state != param state', async () => {
    getCurrentUserMock.mockResolvedValue(sessionUser);
    const res = await callRoute(
      makeReq(
        { code: 'auth_code', state: 'param-state' },
        { 'mail-oauth-state': 'different-state' },
      ),
    );
    expect(res.headers.get('location')).toContain('status=invalid_state');
  });

  it('redirects status=email_mismatch when google email != hub email', async () => {
    getCurrentUserMock.mockResolvedValue(sessionUser);
    exchangeMailCodeMock.mockResolvedValueOnce({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: Date.now() + 3600_000,
      id_token: 't',
      email: 'someone-else@example.com',
      sub: '999',
      granted_scope: 'openid email gmail.send',
    });
    const res = await callRoute(
      makeReq(
        { code: 'auth_code', state: 's' },
        { 'mail-oauth-state': 's' },
      ),
    );
    expect(res.headers.get('location')).toContain('status=email_mismatch');
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('upserts Account and redirects status=connected on success', async () => {
    getCurrentUserMock.mockResolvedValue(sessionUser);
    exchangeMailCodeMock.mockResolvedValueOnce({
      access_token: 'access-fresh',
      refresh_token: 'refresh-fresh',
      expires_at: Date.now() + 3600_000,
      id_token: 'id-token',
      email: 'alice@example.com',
      sub: 'google_sub_alice',
      granted_scope: 'openid email https://www.googleapis.com/auth/gmail.send',
    });
    upsertMock.mockResolvedValueOnce({});

    const res = await callRoute(
      makeReq(
        { code: 'auth_code', state: 'st' },
        { 'mail-oauth-state': 'st' },
      ),
    );
    expect(res.headers.get('location')).toContain('status=connected');
    expect(upsertMock).toHaveBeenCalledOnce();
    const args = upsertMock.mock.calls[0][0];
    expect(args.where.provider_providerAccountId.provider).toBe('google');
    expect(args.where.provider_providerAccountId.providerAccountId).toBe('google_sub_alice');
    expect(args.update.mailSendScope).toContain('gmail.send');
    expect(args.update.mailSendNeedsReauth).toBe(false);
    expect(args.create.refresh_token).toBe('refresh-fresh');
  });

  it('redirects status=oauth_failed when exchange throws', async () => {
    getCurrentUserMock.mockResolvedValue(sessionUser);
    exchangeMailCodeMock.mockRejectedValueOnce(new Error('boom'));
    const res = await callRoute(
      makeReq(
        { code: 'c', state: 's' },
        { 'mail-oauth-state': 's' },
      ),
    );
    expect(res.headers.get('location')).toContain('status=oauth_failed');
  });
});
