/**
 * Tests gmail-oauth.ts — lib/mail/gmail-oauth.ts
 *
 * Couvre :
 *   - getMailOAuthClient throw si ENV manquante
 *   - getMailAuthUrl scopes corrects + access_type=offline + prompt=consent
 *   - getMailAuthUrl propage state
 *   - normalizeTokens decode email/sub depuis id_token
 *   - normalizeTokens throw si access_token / refresh_token / id_token absent
 *   - scopeIncludesGmailSend → matche substring 'gmail.send'
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  getMailOAuthClient,
  getMailAuthUrl,
  normalizeTokens,
  scopeIncludesGmailSend,
  GMAIL_SEND_SCOPES,
} from '@/lib/mail/gmail-oauth';

const REDIRECT = 'https://hub.staging.veridian.site/api/gmail/connect/callback';

function setEnv(cid: string | undefined, secret: string | undefined) {
  if (cid === undefined) delete process.env.GOOGLE_MAIL_CLIENT_ID;
  else process.env.GOOGLE_MAIL_CLIENT_ID = cid;
  if (secret === undefined) delete process.env.GOOGLE_MAIL_CLIENT_SECRET;
  else process.env.GOOGLE_MAIL_CLIENT_SECRET = secret;
}

function makeIdToken(claims: Record<string, unknown>): string {
  // Header + payload + signature factice (on ne vérifie pas la sig — voir lib).
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' }), 'utf-8').toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims), 'utf-8').toString(
    'base64url',
  );
  return `${header}.${payload}.fake-signature`;
}

describe('getMailOAuthClient', () => {
  const origCid = process.env.GOOGLE_MAIL_CLIENT_ID;
  const origSecret = process.env.GOOGLE_MAIL_CLIENT_SECRET;

  afterEach(() => {
    setEnv(origCid, origSecret);
  });

  it('throws if GOOGLE_MAIL_CLIENT_ID missing', () => {
    setEnv(undefined, 'secret');
    expect(() => getMailOAuthClient(REDIRECT)).toThrowError(/not configured/);
  });

  it('throws if GOOGLE_MAIL_CLIENT_SECRET missing', () => {
    setEnv('client-id', undefined);
    expect(() => getMailOAuthClient(REDIRECT)).toThrowError(/not configured/);
  });

  it('returns an OAuth2Client when both ENV set', () => {
    setEnv('client-id', 'secret');
    const client = getMailOAuthClient(REDIRECT);
    expect(client).toBeDefined();
  });
});

describe('getMailAuthUrl', () => {
  beforeEach(() => {
    process.env.GOOGLE_MAIL_CLIENT_ID = 'client-id';
    process.env.GOOGLE_MAIL_CLIENT_SECRET = 'secret';
  });

  it('includes all required scopes', () => {
    const url = getMailAuthUrl('state-abc', REDIRECT);
    const parsed = new URL(url);
    const scope = parsed.searchParams.get('scope') ?? '';
    for (const s of GMAIL_SEND_SCOPES) {
      expect(scope).toContain(s);
    }
  });

  it('uses access_type=offline and prompt=consent', () => {
    const url = getMailAuthUrl('state-abc', REDIRECT);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
  });

  it('propagates state opaque', () => {
    const url = getMailAuthUrl('state-xyz-very-random', REDIRECT);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('state')).toBe('state-xyz-very-random');
  });

  it('uses redirect URI passed in argument', () => {
    const url = getMailAuthUrl('s', 'http://localhost:3000/api/gmail/connect/callback');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/gmail/connect/callback',
    );
  });
});

describe('normalizeTokens', () => {
  const baseId = makeIdToken({ email: 'user@example.com', sub: '1234567890' });

  it('returns normalized shape with email and sub from id_token', () => {
    const out = normalizeTokens({
      access_token: 'a',
      refresh_token: 'r',
      id_token: baseId,
      expiry_date: 1_700_000_000_000,
      scope: 'openid email profile https://www.googleapis.com/auth/gmail.send',
    });
    expect(out.access_token).toBe('a');
    expect(out.refresh_token).toBe('r');
    expect(out.email).toBe('user@example.com');
    expect(out.sub).toBe('1234567890');
    expect(out.expires_at).toBe(1_700_000_000_000);
    expect(out.granted_scope).toContain('gmail.send');
  });

  it('falls back to Date.now+1h when expiry_date absent', () => {
    const before = Date.now() + 59 * 60 * 1000;
    const out = normalizeTokens({
      access_token: 'a',
      refresh_token: 'r',
      id_token: baseId,
    });
    const after = Date.now() + 61 * 60 * 1000;
    expect(out.expires_at).toBeGreaterThanOrEqual(before);
    expect(out.expires_at).toBeLessThanOrEqual(after);
  });

  it('throws if access_token missing', () => {
    expect(() =>
      normalizeTokens({ refresh_token: 'r', id_token: baseId }),
    ).toThrowError(/access_token/);
  });

  it('throws if refresh_token missing', () => {
    expect(() =>
      normalizeTokens({ access_token: 'a', id_token: baseId }),
    ).toThrowError(/refresh_token/);
  });

  it('throws if id_token missing', () => {
    expect(() =>
      normalizeTokens({ access_token: 'a', refresh_token: 'r' }),
    ).toThrowError(/id_token/);
  });

  it('throws if id_token has invalid format', () => {
    expect(() =>
      normalizeTokens({ access_token: 'a', refresh_token: 'r', id_token: 'not-a-jwt' }),
    ).toThrowError(/id_token/);
  });

  it('throws if id_token missing email claim', () => {
    const tok = makeIdToken({ sub: '123' });
    expect(() =>
      normalizeTokens({ access_token: 'a', refresh_token: 'r', id_token: tok }),
    ).toThrowError(/email or sub/);
  });
});

describe('scopeIncludesGmailSend', () => {
  it('returns true when full scope URL present', () => {
    expect(
      scopeIncludesGmailSend(
        'openid email profile https://www.googleapis.com/auth/gmail.send',
      ),
    ).toBe(true);
  });

  it('returns true when only short suffix present', () => {
    expect(scopeIncludesGmailSend('gmail.send')).toBe(true);
  });

  it('returns false when scope absent', () => {
    expect(scopeIncludesGmailSend('openid email profile')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(scopeIncludesGmailSend(null)).toBe(false);
    expect(scopeIncludesGmailSend(undefined)).toBe(false);
    expect(scopeIncludesGmailSend('')).toBe(false);
  });
});
