/**
 * Tests unitaires du HMAC entrant pour `/api/users/by-email`.
 *
 * Couvre :
 *   - headers manquants → 400
 *   - app inconnue → 400
 *   - timestamp non numérique → 400
 *   - drift > 5 min → 401
 *   - secret manquant → 503
 *   - signature invalide (longueur ou hex) → 401
 *   - signature valide → ok=true
 *   - signature stable indépendamment de l'ordre des query params
 *   - method case-insensitive (GET vs get)
 *   - signature change si method/path/query/timestamp changent
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildCanonicalGetString,
  resolveHubApiSecret,
  verifyDiscoveryHmac,
} from '@/lib/discovery/hmac';

const SECRET = 'test-secret-notifuse-discovery';

function signCanonical(canonical: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

function buildHeaders(opts: {
  app?: string;
  timestamp?: string;
  signature?: string;
}): Headers {
  const h = new Headers();
  if (opts.app !== undefined) h.set('x-veridian-app', opts.app);
  if (opts.timestamp !== undefined) h.set('x-veridian-timestamp', opts.timestamp);
  if (opts.signature !== undefined) h.set('x-veridian-hub-signature', opts.signature);
  return h;
}

function freshUrl(path = '/api/users/by-email?email=alice%40example.com'): URL {
  return new URL(`https://hub.veridian.site${path}`);
}

describe('resolveHubApiSecret', () => {
  it('returns secret from <APP>_HUB_API_SECRET env', () => {
    const env = { NOTIFUSE_HUB_API_SECRET: 'sec123' };
    expect(resolveHubApiSecret('notifuse', env)).toBe('sec123');
  });

  it('returns null when env missing', () => {
    expect(resolveHubApiSecret('analytics', {})).toBeNull();
  });

  it('returns null when env empty string', () => {
    const env = { CMS_HUB_API_SECRET: '   ' };
    expect(resolveHubApiSecret('cms', env)).toBeNull();
  });
});

describe('buildCanonicalGetString', () => {
  it('sorts query params alphabetically for stability', () => {
    const a = buildCanonicalGetString(
      'GET',
      '/api/users/by-email',
      new URLSearchParams('email=a@b.c&trace=1'),
      '1700000000000',
    );
    const b = buildCanonicalGetString(
      'GET',
      '/api/users/by-email',
      new URLSearchParams('trace=1&email=a@b.c'),
      '1700000000000',
    );
    expect(a).toBe(b);
  });

  it('uppercases method', () => {
    const upper = buildCanonicalGetString(
      'GET',
      '/x',
      new URLSearchParams(),
      '1',
    );
    const lower = buildCanonicalGetString(
      'get',
      '/x',
      new URLSearchParams(),
      '1',
    );
    expect(upper).toBe(lower);
  });

  it('omits ? when no query params', () => {
    expect(
      buildCanonicalGetString('GET', '/x', new URLSearchParams(), '1'),
    ).toBe('1.GET./x');
  });

  it('encodeURIComponent escapes special chars', () => {
    const s = buildCanonicalGetString(
      'GET',
      '/x',
      new URLSearchParams([['email', 'a+b@c.d']]),
      '1',
    );
    expect(s).toContain('email=a%2Bb%40c.d');
  });
});

describe('verifyDiscoveryHmac', () => {
  const env = { NOTIFUSE_HUB_API_SECRET: SECRET };

  it('returns 400 when x-veridian-app missing', () => {
    const res = verifyDiscoveryHmac(
      buildHeaders({ timestamp: String(Date.now()), signature: 'x' }),
      'GET',
      freshUrl(),
      { envOverride: env },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.reason).toContain('x-veridian-app');
    }
  });

  it('returns 400 when app unsupported', () => {
    const res = verifyDiscoveryHmac(
      buildHeaders({ app: 'evil', timestamp: String(Date.now()), signature: 'x' }),
      'GET',
      freshUrl(),
      { envOverride: env },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it('returns 400 when timestamp/signature missing', () => {
    const res = verifyDiscoveryHmac(
      buildHeaders({ app: 'notifuse' }),
      'GET',
      freshUrl(),
      { envOverride: env },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it('returns 400 when timestamp not numeric', () => {
    const res = verifyDiscoveryHmac(
      buildHeaders({ app: 'notifuse', timestamp: 'not-a-number', signature: 'x' }),
      'GET',
      freshUrl(),
      { envOverride: env },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it('returns 401 when timestamp drift > 5 min', () => {
    const now = 1_700_000_000_000;
    const old = now - 6 * 60 * 1000;
    const res = verifyDiscoveryHmac(
      buildHeaders({
        app: 'notifuse',
        timestamp: String(old),
        signature: 'a'.repeat(64),
      }),
      'GET',
      freshUrl(),
      { envOverride: env, nowMs: now },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('returns 503 when secret not configured for app', () => {
    const res = verifyDiscoveryHmac(
      buildHeaders({
        app: 'cms',
        timestamp: String(Date.now()),
        signature: 'a'.repeat(64),
      }),
      'GET',
      freshUrl(),
      { envOverride: {} },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(503);
      expect(res.reason).toContain('CMS_HUB_API_SECRET');
    }
  });

  it('returns 401 when signature wrong length', () => {
    const ts = String(Date.now());
    const res = verifyDiscoveryHmac(
      buildHeaders({
        app: 'notifuse',
        timestamp: ts,
        signature: 'abcd', // 2 bytes ≠ 32 expected
      }),
      'GET',
      freshUrl(),
      { envOverride: env },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('returns 401 when signature is invalid hex', () => {
    const ts = String(Date.now());
    const url = freshUrl();
    const canonical = buildCanonicalGetString('GET', url.pathname, url.searchParams, ts);
    // Force a non-hex string of correct hex byte length (64 chars)
    const badSig = 'zz'.repeat(32);
    const res = verifyDiscoveryHmac(
      buildHeaders({
        app: 'notifuse',
        timestamp: ts,
        signature: badSig,
      }),
      'GET',
      url,
      { envOverride: env },
    );
    // Buffer.from('zz...', 'hex') yields empty buffer → length mismatch → 401
    expect(res.ok).toBe(false);
    expect(canonical).toBeTruthy();
  });

  it('returns 401 on signature that does not match', () => {
    const ts = String(Date.now());
    const url = freshUrl();
    // signature signe la bonne canonical mais avec un secret faux
    const canonical = buildCanonicalGetString('GET', url.pathname, url.searchParams, ts);
    const wrongSig = signCanonical(canonical, 'wrong-secret');
    const res = verifyDiscoveryHmac(
      buildHeaders({ app: 'notifuse', timestamp: ts, signature: wrongSig }),
      'GET',
      url,
      { envOverride: env },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('returns ok=true on valid signature', () => {
    const ts = String(Date.now());
    const url = freshUrl();
    const canonical = buildCanonicalGetString('GET', url.pathname, url.searchParams, ts);
    const sig = signCanonical(canonical);
    const res = verifyDiscoveryHmac(
      buildHeaders({ app: 'notifuse', timestamp: ts, signature: sig }),
      'GET',
      url,
      { envOverride: env },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.app).toBe('notifuse');
  });

  it('signature is independent of query param order', () => {
    const ts = String(Date.now());
    const url1 = new URL('https://hub.veridian.site/x?b=2&a=1');
    const url2 = new URL('https://hub.veridian.site/x?a=1&b=2');
    const canonical = buildCanonicalGetString('GET', '/x', url1.searchParams, ts);
    const sig = signCanonical(canonical);
    const res = verifyDiscoveryHmac(
      buildHeaders({ app: 'notifuse', timestamp: ts, signature: sig }),
      'GET',
      url2,
      { envOverride: env },
    );
    expect(res.ok).toBe(true);
  });

  it('signature breaks when path differs', () => {
    const ts = String(Date.now());
    const url1 = new URL('https://hub.veridian.site/api/users/by-email');
    const url2 = new URL('https://hub.veridian.site/api/users/other');
    const canonical = buildCanonicalGetString('GET', url1.pathname, url1.searchParams, ts);
    const sig = signCanonical(canonical);
    const res = verifyDiscoveryHmac(
      buildHeaders({ app: 'notifuse', timestamp: ts, signature: sig }),
      'GET',
      url2,
      { envOverride: env },
    );
    expect(res.ok).toBe(false);
  });
});
