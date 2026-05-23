/**
 * Tests pour lib/billing/billing-state-hmac.ts (Pattern A §6.1).
 */

import { describe, test, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  SUPPORTED_APPS,
  isSupportedApp,
  resolveBillingStateSecret,
  verifyBillingStateHmac,
} from '@/lib/billing/billing-state-hmac';

const NOW = 1_780_000_000_000;
const SECRET = 'test-secret-very-long-for-hmac-purposes';

function signedHeaders(opts: {
  app: string;
  ts?: number;
  rawBody?: string;
  secret?: string;
  badSig?: boolean;
}): Headers {
  const ts = opts.ts ?? NOW;
  const body = opts.rawBody ?? '';
  const sigBase = `${ts}.${body}`;
  const sig = opts.badSig
    ? 'deadbeef'.repeat(8)
    : createHmac('sha256', opts.secret ?? SECRET).update(sigBase).digest('hex');
  return new Headers({
    'x-veridian-app': opts.app,
    'x-veridian-timestamp': String(ts),
    'x-veridian-hub-signature': sig,
  });
}

describe('SUPPORTED_APPS', () => {
  test('expose la liste figée des apps connues du Hub', () => {
    expect(SUPPORTED_APPS).toEqual(['notifuse', 'prospection', 'analytics', 'cms']);
  });
});

describe('isSupportedApp', () => {
  test('reconnaît les apps supportées et rejette le reste', () => {
    expect(isSupportedApp('notifuse')).toBe(true);
    expect(isSupportedApp('prospection')).toBe(true);
    expect(isSupportedApp('analytics')).toBe(true);
    expect(isSupportedApp('cms')).toBe(true);
    expect(isSupportedApp('hub')).toBe(false);
    expect(isSupportedApp('')).toBe(false);
    expect(isSupportedApp('NOTIFUSE')).toBe(false); // case sensitive
  });
});

describe('resolveBillingStateSecret', () => {
  test('résout <APP>_HUB_API_SECRET depuis env, sinon null', () => {
    const env = {
      NOTIFUSE_HUB_API_SECRET: 'notifuse-secret',
      PROSPECTION_HUB_API_SECRET: '   ',
    } as NodeJS.ProcessEnv;
    expect(resolveBillingStateSecret('notifuse', env)).toBe('notifuse-secret');
    expect(resolveBillingStateSecret('prospection', env)).toBeNull(); // whitespace = pas configuré
    expect(resolveBillingStateSecret('analytics', env)).toBeNull();
    expect(resolveBillingStateSecret('cms', env)).toBeNull();
  });
});

describe('verifyBillingStateHmac', () => {
  const env = {
    NOTIFUSE_HUB_API_SECRET: SECRET,
  } as NodeJS.ProcessEnv;

  test('accepte une signature valide avec rawBody vide (GET)', () => {
    const headers = signedHeaders({ app: 'notifuse' });
    const r = verifyBillingStateHmac(headers, '', { envOverride: env, nowMs: NOW });
    expect(r).toEqual({ ok: true, app: 'notifuse' });
  });

  test('400 si header x-veridian-app manquant', () => {
    const headers = new Headers({
      'x-veridian-timestamp': String(NOW),
      'x-veridian-hub-signature': 'abc',
    });
    const r = verifyBillingStateHmac(headers, '', { envOverride: env, nowMs: NOW });
    expect(r).toEqual({
      ok: false,
      reason: 'missing x-veridian-app header',
      status: 400,
    });
  });

  test('400 si app non supportée', () => {
    const headers = signedHeaders({ app: 'hub' });
    const r = verifyBillingStateHmac(headers, '', { envOverride: env, nowMs: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.reason).toMatch(/unsupported app/);
    }
  });

  test('400 si timestamp ou signature manquant', () => {
    const noTs = new Headers({ 'x-veridian-app': 'notifuse', 'x-veridian-hub-signature': 'x' });
    expect(verifyBillingStateHmac(noTs, '', { envOverride: env, nowMs: NOW })).toMatchObject({
      ok: false,
      status: 400,
    });
    const noSig = new Headers({ 'x-veridian-app': 'notifuse', 'x-veridian-timestamp': String(NOW) });
    expect(verifyBillingStateHmac(noSig, '', { envOverride: env, nowMs: NOW })).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  test('400 si timestamp non numérique', () => {
    const headers = new Headers({
      'x-veridian-app': 'notifuse',
      'x-veridian-timestamp': 'not-a-number',
      'x-veridian-hub-signature': 'abc',
    });
    const r = verifyBillingStateHmac(headers, '', { envOverride: env, nowMs: NOW });
    expect(r).toMatchObject({ ok: false, status: 400, reason: 'invalid timestamp' });
  });

  test('401 si drift timestamp > 5 minutes (anti-replay)', () => {
    const headers = signedHeaders({ app: 'notifuse', ts: NOW - 6 * 60 * 1000 });
    const r = verifyBillingStateHmac(headers, '', { envOverride: env, nowMs: NOW });
    expect(r).toMatchObject({ ok: false, status: 401 });
    if (!r.ok) expect(r.reason).toMatch(/drift/);
  });

  test('503 si secret non configuré pour cette app', () => {
    const headers = signedHeaders({ app: 'analytics' });
    const r = verifyBillingStateHmac(headers, '', { envOverride: env, nowMs: NOW });
    expect(r).toMatchObject({
      ok: false,
      status: 503,
      reason: 'ANALYTICS_HUB_API_SECRET not configured',
    });
  });

  test('401 si signature invalide (timing-safe)', () => {
    const headers = signedHeaders({ app: 'notifuse', badSig: true });
    const r = verifyBillingStateHmac(headers, '', { envOverride: env, nowMs: NOW });
    expect(r).toMatchObject({ ok: false, status: 401, reason: 'invalid signature' });
  });

  test('401 si signature signée avec un autre secret', () => {
    const headers = signedHeaders({ app: 'notifuse', secret: 'other-secret-string' });
    const r = verifyBillingStateHmac(headers, '', { envOverride: env, nowMs: NOW });
    expect(r).toMatchObject({ ok: false, status: 401, reason: 'invalid signature' });
  });

  test('401 si signature mal encodée (non-hex)', () => {
    const headers = new Headers({
      'x-veridian-app': 'notifuse',
      'x-veridian-timestamp': String(NOW),
      'x-veridian-hub-signature': 'zzz-not-hex',
    });
    const r = verifyBillingStateHmac(headers, '', { envOverride: env, nowMs: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
});
