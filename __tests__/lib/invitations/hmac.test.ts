/**
 * Test HMAC vérification pour les appels app downstream → Hub
 * sur le scope invitations.
 *
 * Vérifie :
 *   - signature valide → ok
 *   - signature invalide → 401
 *   - drift > 5min → 401
 *   - app non supportée → 400
 *   - secret manquant → 503
 *   - headers manquants → 400
 *   - mismatch length (forgé court) → 401 (pas un throw)
 *   - timing-safe (longueur égale mais valeur différente)
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyInvitationHmac,
  resolveInvitationSecret,
  isSupportedApp,
  SUPPORTED_APPS,
} from '@/lib/invitations/hmac';

function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

const SECRET = 'super-secret-test-key-for-prospection';
const ENV_OVERRIDE = {
  HUB_INVITATION_SECRET_PROSPECTION: SECRET,
  HUB_INVITATION_SECRET_NOTIFUSE: 'another-secret-for-notifuse',
} as NodeJS.ProcessEnv;

function makeHeaders(opts: {
  app?: string;
  timestamp?: string;
  signature?: string;
}): Headers {
  const h = new Headers();
  if (opts.app !== undefined) h.set('x-veridian-app', opts.app);
  if (opts.timestamp !== undefined) h.set('x-veridian-timestamp', opts.timestamp);
  if (opts.signature !== undefined)
    h.set('x-veridian-invitation-signature', opts.signature);
  return h;
}

describe('verifyInvitationHmac', () => {
  const now = Date.now();
  const body = '{"invitee_email":"a@b.com","target_app":"prospection"}';
  const ts = String(now);

  it('accepts a valid signature', () => {
    const sig = sign(SECRET, ts, body);
    const result = verifyInvitationHmac(
      makeHeaders({ app: 'prospection', timestamp: ts, signature: sig }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.app).toBe('prospection');
  });

  it('rejects invalid signature (401)', () => {
    const result = verifyInvitationHmac(
      makeHeaders({
        app: 'prospection',
        timestamp: ts,
        signature: 'a'.repeat(64),
      }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects body mismatch (signature OK for other body) — 401', () => {
    const sigForOther = sign(SECRET, ts, '{"other":"body"}');
    const result = verifyInvitationHmac(
      makeHeaders({ app: 'prospection', timestamp: ts, signature: sigForOther }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects signature length mismatch without throwing — 401', () => {
    const result = verifyInvitationHmac(
      makeHeaders({
        app: 'prospection',
        timestamp: ts,
        signature: 'abcd', // 4 chars, hex valide mais mauvaise longueur
      }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects malformed hex signature — 401 (no throw)', () => {
    const result = verifyInvitationHmac(
      makeHeaders({
        app: 'prospection',
        timestamp: ts,
        signature: 'not-hex-at-all-zzz',
      }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects timestamp drift > 5min (401)', () => {
    const oldTs = String(now - 6 * 60 * 1000); // 6 min ago
    const sig = sign(SECRET, oldTs, body);
    const result = verifyInvitationHmac(
      makeHeaders({ app: 'prospection', timestamp: oldTs, signature: sig }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects future timestamp drift > 5min (401)', () => {
    const futureTs = String(now + 6 * 60 * 1000);
    const sig = sign(SECRET, futureTs, body);
    const result = verifyInvitationHmac(
      makeHeaders({
        app: 'prospection',
        timestamp: futureTs,
        signature: sig,
      }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects non-numeric timestamp (400)', () => {
    const result = verifyInvitationHmac(
      makeHeaders({
        app: 'prospection',
        timestamp: 'not-a-number',
        signature: 'a'.repeat(64),
      }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('rejects unsupported app (400)', () => {
    const result = verifyInvitationHmac(
      makeHeaders({
        app: 'evil-app',
        timestamp: ts,
        signature: 'a'.repeat(64),
      }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('returns 503 if secret not configured for the app', () => {
    const sig = sign('whatever', ts, body);
    const result = verifyInvitationHmac(
      makeHeaders({ app: 'analytics', timestamp: ts, signature: sig }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it('rejects missing x-veridian-app (400)', () => {
    const result = verifyInvitationHmac(
      makeHeaders({ timestamp: ts, signature: 'a'.repeat(64) }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('rejects missing signature header (400)', () => {
    const result = verifyInvitationHmac(
      makeHeaders({ app: 'prospection', timestamp: ts }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('uses the correct secret per app (no cross-app forge)', () => {
    // Sign with Notifuse secret, but claim to be Prospection.
    // Even with valid Notifuse signature, must reject.
    const notifuseSecret = ENV_OVERRIDE.HUB_INVITATION_SECRET_NOTIFUSE!;
    const sig = sign(notifuseSecret, ts, body);
    const result = verifyInvitationHmac(
      makeHeaders({ app: 'prospection', timestamp: ts, signature: sig }),
      body,
      { envOverride: ENV_OVERRIDE, nowMs: now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});

describe('isSupportedApp', () => {
  it('accepts known apps', () => {
    for (const app of SUPPORTED_APPS) {
      expect(isSupportedApp(app)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isSupportedApp('hub')).toBe(false);
    expect(isSupportedApp('')).toBe(false);
    expect(isSupportedApp('NOTIFUSE')).toBe(false); // case-sensitive
  });
});

describe('resolveInvitationSecret', () => {
  it('returns secret from env (uppercase suffix)', () => {
    expect(resolveInvitationSecret('prospection', ENV_OVERRIDE)).toBe(SECRET);
  });

  it('returns null if env not set', () => {
    expect(resolveInvitationSecret('analytics', ENV_OVERRIDE)).toBeNull();
  });

  it('returns null on whitespace-only secret', () => {
    const env = { HUB_INVITATION_SECRET_CMS: '   ' } as NodeJS.ProcessEnv;
    expect(resolveInvitationSecret('cms', env)).toBeNull();
  });
});
