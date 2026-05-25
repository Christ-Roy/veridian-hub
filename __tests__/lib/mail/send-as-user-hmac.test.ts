/**
 * Tests send-as-user-hmac.ts — lib/mail/send-as-user-hmac.ts
 *
 * Couvre :
 *   - signature valide → ok + app
 *   - signature invalide → 401
 *   - drift > 5min → 401
 *   - app non supportée → 400
 *   - secret manquant → 503
 *   - headers manquants → 400
 *   - mismatch length (forgé court) → 401 sans throw
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  verifySendAsUserHmac,
  resolveSendAsUserSecret,
  isSupportedApp,
  SUPPORTED_APPS,
} from '@/lib/mail/send-as-user-hmac';

const SECRET = 'super-secret-test-key-prospection';
const ENV: NodeJS.ProcessEnv = {
  PROSPECTION_HUB_API_SECRET: SECRET,
  NOTIFUSE_HUB_API_SECRET: 'another-notifuse-secret',
};

function sign(secret: string, ts: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

function makeHeaders(o: {
  app?: string;
  timestamp?: string;
  signature?: string;
}): Headers {
  const h = new Headers();
  if (o.app !== undefined) h.set('x-veridian-app', o.app);
  if (o.timestamp !== undefined) h.set('x-veridian-timestamp', o.timestamp);
  if (o.signature !== undefined) h.set('x-veridian-hub-signature', o.signature);
  return h;
}

describe('isSupportedApp / SUPPORTED_APPS', () => {
  it('includes the 4 downstream apps', () => {
    expect(SUPPORTED_APPS).toEqual(['notifuse', 'prospection', 'analytics', 'cms']);
  });
  it('rejects unknown apps', () => {
    expect(isSupportedApp('hub')).toBe(false);
    expect(isSupportedApp('twenty')).toBe(false);
  });
});

describe('resolveSendAsUserSecret', () => {
  it('reads <APP>_HUB_API_SECRET env var', () => {
    expect(resolveSendAsUserSecret('prospection', ENV)).toBe(SECRET);
    expect(resolveSendAsUserSecret('notifuse', ENV)).toBe('another-notifuse-secret');
  });

  it('returns null when env missing', () => {
    expect(resolveSendAsUserSecret('analytics', ENV)).toBeNull();
  });

  it('returns null for empty/whitespace-only', () => {
    expect(
      resolveSendAsUserSecret('cms', { CMS_HUB_API_SECRET: '   ' }),
    ).toBeNull();
  });
});

describe('verifySendAsUserHmac', () => {
  const now = Date.now();
  const body = '{"user_id":"x","to":"a@b.c"}';
  const ts = String(now);

  it('accepts a valid signature', () => {
    const sig = sign(SECRET, ts, body);
    const r = verifySendAsUserHmac(
      makeHeaders({ app: 'prospection', timestamp: ts, signature: sig }),
      body,
      { envOverride: ENV, nowMs: now },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.app).toBe('prospection');
  });

  it('rejects invalid signature (401)', () => {
    const r = verifySendAsUserHmac(
      makeHeaders({ app: 'prospection', timestamp: ts, signature: 'a'.repeat(64) }),
      body,
      { envOverride: ENV, nowMs: now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('rejects body mismatch (sig OK for other body) — 401', () => {
    const sig = sign(SECRET, ts, 'different');
    const r = verifySendAsUserHmac(
      makeHeaders({ app: 'prospection', timestamp: ts, signature: sig }),
      body,
      { envOverride: ENV, nowMs: now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('rejects when drift > 5min (401)', () => {
    const futureTs = String(now + 10 * 60 * 1000);
    const sig = sign(SECRET, futureTs, body);
    const r = verifySendAsUserHmac(
      makeHeaders({ app: 'prospection', timestamp: futureTs, signature: sig }),
      body,
      { envOverride: ENV, nowMs: now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('rejects unsupported app (400)', () => {
    const r = verifySendAsUserHmac(
      makeHeaders({ app: 'hub', timestamp: ts, signature: 'x' }),
      body,
      { envOverride: ENV, nowMs: now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('rejects missing secret (503)', () => {
    const sig = sign(SECRET, ts, body);
    const r = verifySendAsUserHmac(
      makeHeaders({ app: 'analytics', timestamp: ts, signature: sig }),
      body,
      { envOverride: ENV, nowMs: now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });

  it('rejects missing headers (400)', () => {
    const r = verifySendAsUserHmac(
      makeHeaders({ app: 'prospection' }),
      body,
      { envOverride: ENV, nowMs: now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('rejects forged short signature (401, no throw)', () => {
    const r = verifySendAsUserHmac(
      makeHeaders({ app: 'prospection', timestamp: ts, signature: 'aa' }),
      body,
      { envOverride: ENV, nowMs: now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('rejects invalid timestamp (NaN) — 400', () => {
    const r = verifySendAsUserHmac(
      makeHeaders({
        app: 'prospection',
        timestamp: 'not-a-number',
        signature: 'aa',
      }),
      body,
      { envOverride: ENV, nowMs: now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});
