/**
 * Tests /api/gmail/connect — démarrage OAuth flow Mail Sender.
 *
 * Couvre :
 *   - 302 redirect vers Google consent quand session présente
 *   - 302 redirect vers /login si pas de session
 *   - state cookie posé
 *   - return param sanitisé (rejette les // externes)
 *   - 503 si GOOGLE_MAIL_CLIENT_ID absent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sessionUser = { id: 'cuid_user', email: 'a@b.com', name: 'A', image: null, supabaseUserId: 'uid' };
const getCurrentUserMock = vi.fn();
vi.mock('@/lib/auth/get-user', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env.GOOGLE_MAIL_CLIENT_ID = 'client-id';
  process.env.GOOGLE_MAIL_CLIENT_SECRET = 'secret';
  getCurrentUserMock.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function callRoute(url: string) {
  const route = await import('@/app/api/gmail/connect/route');
  const req = new Request(url);
  return route.GET(req as any);
}

describe('GET /api/gmail/connect', () => {
  it('redirects to /login when no session', async () => {
    getCurrentUserMock.mockResolvedValueOnce(null);
    const res = await callRoute('https://hub.staging.veridian.site/api/gmail/connect');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('redirects 302 to Google consent and sets state cookie', async () => {
    getCurrentUserMock.mockResolvedValueOnce(sessionUser);
    const res = await callRoute('https://hub.staging.veridian.site/api/gmail/connect');
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('accounts.google.com');
    expect(loc).toContain('client_id=client-id');
    expect(loc).toContain('access_type=offline');
    expect(loc).toContain('prompt=consent');

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('mail-oauth-state=');
  });

  it('preserves return param when starts with /', async () => {
    getCurrentUserMock.mockResolvedValueOnce(sessionUser);
    const res = await callRoute(
      'https://hub.staging.veridian.site/api/gmail/connect?return=/settings/mail-account',
    );
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('mail-oauth-return=');
    expect(setCookie).toContain(encodeURIComponent('/settings/mail-account'));
  });

  it('rejects open-redirect attempt //evil.com', async () => {
    getCurrentUserMock.mockResolvedValueOnce(sessionUser);
    const res = await callRoute(
      'https://hub.staging.veridian.site/api/gmail/connect?return=//evil.com/x',
    );
    const setCookie = res.headers.get('set-cookie') ?? '';
    // Le cookie return doit être vide (filtré)
    const returnMatch = setCookie.match(/mail-oauth-return=([^;]*)/);
    expect(returnMatch?.[1] ?? '').toBe('');
  });

  it('returns 503 when GOOGLE_MAIL_CLIENT_ID missing', async () => {
    delete process.env.GOOGLE_MAIL_CLIENT_ID;
    getCurrentUserMock.mockResolvedValueOnce(sessionUser);
    const res = await callRoute('https://hub.staging.veridian.site/api/gmail/connect');
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('mail_oauth_not_configured');
  });
});
