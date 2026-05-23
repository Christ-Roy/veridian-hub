/**
 * Tests pour lib/auth/rate-limit.ts
 *
 * Couvre :
 *  - cap respecté (N requêtes OK, N+1 = bloquée)
 *  - fenêtre glissante (les hits anciens sortent du compte)
 *  - retryAfterSeconds positif et cohérent
 *  - extractClientIp priorité x-forwarded-for → x-real-ip → 'unknown'
 *  - x-forwarded-for chained : on prend la 1re IP
 *  - constructor refuse les valeurs invalides
 *  - shouldBypassRateLimit : triple garde-fou anti-fuite prod
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  RateLimiter,
  extractClientIp,
  shouldBypassRateLimit,
} from '@/lib/auth/rate-limit';

describe('RateLimiter', () => {
  it('laisse passer jusqu\'au cap, refuse au-delà', () => {
    const rl = new RateLimiter({ capacity: 3, windowMs: 1000, name: 'test' });
    expect(rl.enforce('ip1').ok).toBe(true);
    expect(rl.enforce('ip1').ok).toBe(true);
    expect(rl.enforce('ip1').ok).toBe(true);
    const blocked = rl.enforce('ip1');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.remaining).toBe(0);
    }
  });

  it('compte indépendamment par key (IP)', () => {
    const rl = new RateLimiter({ capacity: 2, windowMs: 1000, name: 'test' });
    expect(rl.enforce('ip1').ok).toBe(true);
    expect(rl.enforce('ip1').ok).toBe(true);
    expect(rl.enforce('ip1').ok).toBe(false);
    // ip2 démarre frais
    expect(rl.enforce('ip2').ok).toBe(true);
    expect(rl.enforce('ip2').ok).toBe(true);
    expect(rl.enforce('ip2').ok).toBe(false);
  });

  it('fenêtre glissante : un hit vieux sort du compte', () => {
    const rl = new RateLimiter({ capacity: 2, windowMs: 1000, name: 'test' });
    const t0 = 1_000_000;
    expect(rl.enforce('ip1', t0).ok).toBe(true);
    expect(rl.enforce('ip1', t0 + 100).ok).toBe(true);
    // 3e à t0+200 → KO
    expect(rl.enforce('ip1', t0 + 200).ok).toBe(false);
    // Mais après expiration de la fenêtre, on peut reprendre
    // (les 3 hits vieux de >1000ms sont GC'd)
    expect(rl.enforce('ip1', t0 + 2000).ok).toBe(true);
  });

  it('les tentatives refusées comptent aussi (pas de bypass)', () => {
    const rl = new RateLimiter({ capacity: 1, windowMs: 1000, name: 'test' });
    expect(rl.enforce('ip1').ok).toBe(true);
    expect(rl.enforce('ip1').ok).toBe(false);
    expect(rl.enforce('ip1').ok).toBe(false);
    expect(rl.enforce('ip1').ok).toBe(false);
    // Toutes refusées mais comptées : la 5e doit toujours être refusée
    expect(rl.enforce('ip1').ok).toBe(false);
  });

  it('remaining décompte correctement les tentatives autorisées', () => {
    const rl = new RateLimiter({ capacity: 3, windowMs: 1000, name: 'test' });
    const r1 = rl.enforce('ip1');
    expect(r1.ok && r1.remaining).toBe(2);
    const r2 = rl.enforce('ip1');
    expect(r2.ok && r2.remaining).toBe(1);
    const r3 = rl.enforce('ip1');
    expect(r3.ok && r3.remaining).toBe(0);
  });

  it('reset() vide le storage', () => {
    const rl = new RateLimiter({ capacity: 1, windowMs: 1000, name: 'test' });
    rl.enforce('ip1');
    expect(rl.size()).toBe(1);
    rl.reset();
    expect(rl.size()).toBe(0);
    // Après reset, on peut reprendre
    expect(rl.enforce('ip1').ok).toBe(true);
  });

  it('constructor refuse capacity <= 0', () => {
    expect(() => new RateLimiter({ capacity: 0, windowMs: 1000, name: 'x' })).toThrow();
    expect(() => new RateLimiter({ capacity: -1, windowMs: 1000, name: 'x' })).toThrow();
  });

  it('constructor refuse windowMs <= 0', () => {
    expect(() => new RateLimiter({ capacity: 1, windowMs: 0, name: 'x' })).toThrow();
    expect(() => new RateLimiter({ capacity: 1, windowMs: -100, name: 'x' })).toThrow();
  });
});

describe('extractClientIp', () => {
  const make = (headers: Record<string, string>) => new Headers(headers);

  it('prend la première IP de x-forwarded-for', () => {
    expect(extractClientIp(make({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 192.168.1.1' }))).toBe(
      '1.2.3.4'
    );
  });

  it('trim les espaces autour des IPs', () => {
    expect(extractClientIp(make({ 'x-forwarded-for': '  1.2.3.4 , 10.0.0.1' }))).toBe('1.2.3.4');
  });

  it('fallback x-real-ip si x-forwarded-for absent', () => {
    expect(extractClientIp(make({ 'x-real-ip': '5.6.7.8' }))).toBe('5.6.7.8');
  });

  it('priorité x-forwarded-for sur x-real-ip', () => {
    expect(
      extractClientIp(
        make({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' })
      )
    ).toBe('1.2.3.4');
  });

  it('retourne "unknown" si aucun header', () => {
    expect(extractClientIp(make({}))).toBe('unknown');
  });

  it('retourne "unknown" si x-forwarded-for vide', () => {
    expect(extractClientIp(make({ 'x-forwarded-for': '' }))).toBe('unknown');
  });
});

describe('exported limiter instances', () => {
  it('exports adminApiLimiter avec capacity 30/min (anti-brute-force secret)', async () => {
    const { adminApiLimiter } = await import('@/lib/auth/rate-limit');
    adminApiLimiter.reset();
    // 30 hits doivent passer, 31e refusée
    for (let i = 0; i < 30; i++) {
      expect(adminApiLimiter.enforce('test-ip').ok).toBe(true);
    }
    expect(adminApiLimiter.enforce('test-ip').ok).toBe(false);
    adminApiLimiter.reset();
  });

  it('exports oauthStartLimiter avec capacity 10/min', async () => {
    const { oauthStartLimiter } = await import('@/lib/auth/rate-limit');
    oauthStartLimiter.reset();
    for (let i = 0; i < 10; i++) {
      expect(oauthStartLimiter.enforce('test-ip-oauth').ok).toBe(true);
    }
    expect(oauthStartLimiter.enforce('test-ip-oauth').ok).toBe(false);
    oauthStartLimiter.reset();
  });

  it('exports oauthCallbackLimiter avec capacity 30/min', async () => {
    const { oauthCallbackLimiter } = await import('@/lib/auth/rate-limit');
    oauthCallbackLimiter.reset();
    for (let i = 0; i < 30; i++) {
      expect(oauthCallbackLimiter.enforce('test-ip-cb').ok).toBe(true);
    }
    expect(oauthCallbackLimiter.enforce('test-ip-cb').ok).toBe(false);
    oauthCallbackLimiter.reset();
  });

  it('exports signupLimiter avec capacity 5/min (anti-DoS signup public)', async () => {
    const { signupLimiter } = await import('@/lib/auth/rate-limit');
    signupLimiter.reset();
    for (let i = 0; i < 5; i++) {
      expect(signupLimiter.enforce('test-ip-signup').ok).toBe(true);
    }
    expect(signupLimiter.enforce('test-ip-signup').ok).toBe(false);
    signupLimiter.reset();
  });

  it('exports credentialsLoginLimiter avec capacity 5/min (anti-brute-force password)', async () => {
    const { credentialsLoginLimiter } = await import('@/lib/auth/rate-limit');
    credentialsLoginLimiter.reset();
    for (let i = 0; i < 5; i++) {
      expect(credentialsLoginLimiter.enforce('test-ip-creds').ok).toBe(true);
    }
    expect(credentialsLoginLimiter.enforce('test-ip-creds').ok).toBe(false);
    credentialsLoginLimiter.reset();
  });

  it('exports invitationCreateLimiter avec capacity 60/min (anti-flood HMAC)', async () => {
    const { invitationCreateLimiter } = await import('@/lib/auth/rate-limit');
    invitationCreateLimiter.reset();
    for (let i = 0; i < 60; i++) {
      expect(invitationCreateLimiter.enforce('test-ip-inv').ok).toBe(true);
    }
    expect(invitationCreateLimiter.enforce('test-ip-inv').ok).toBe(false);
    invitationCreateLimiter.reset();
  });

  it('exports invitationVerifyLimiter avec capacity 30/min (anti brute-force token)', async () => {
    const { invitationVerifyLimiter } = await import('@/lib/auth/rate-limit');
    invitationVerifyLimiter.reset();
    for (let i = 0; i < 30; i++) {
      expect(invitationVerifyLimiter.enforce('test-ip-verify').ok).toBe(true);
    }
    expect(invitationVerifyLimiter.enforce('test-ip-verify').ok).toBe(false);
    invitationVerifyLimiter.reset();
  });

  it('exports billingStatePollLimiter avec capacity 60/min (POLL billing-state par secret)', async () => {
    // Limiter introduit par l'agent billing (commit 49b18e8) pour
    // GET /api/tenants/[tenantId]/billing-state — réconciliation §6.3.
    // Couvert ici car la règle 1-pour-1 du scanner exige un test() par
    // nouvel export public et le contrat de cap par secret doit rester
    // stable (un changement non-intentionnel = breaking pour les cron
    // downstream qui poll cet endpoint).
    const { billingStatePollLimiter } = await import('@/lib/auth/rate-limit');
    billingStatePollLimiter.reset();
    for (let i = 0; i < 60; i++) {
      expect(billingStatePollLimiter.enforce('app:notifuse').ok).toBe(true);
    }
    expect(billingStatePollLimiter.enforce('app:notifuse').ok).toBe(false);
    // Isolation par clé : une autre app/secret n'est pas affectée.
    expect(billingStatePollLimiter.enforce('app:prospection').ok).toBe(true);
    billingStatePollLimiter.reset();
  });

  it('exports discoveryPreVerifyLimiter avec capacity 60/min (anti-flood pré-HMAC discovery)', async () => {
    const { discoveryPreVerifyLimiter } = await import('@/lib/auth/rate-limit');
    discoveryPreVerifyLimiter.reset();
    for (let i = 0; i < 60; i++) {
      expect(discoveryPreVerifyLimiter.enforce('test-ip-disc-pre').ok).toBe(true);
    }
    expect(discoveryPreVerifyLimiter.enforce('test-ip-disc-pre').ok).toBe(false);
    discoveryPreVerifyLimiter.reset();
  });

  it('exports discoveryAppLimiter avec capacity 30/min (plafond par secret HMAC discovery)', async () => {
    const { discoveryAppLimiter } = await import('@/lib/auth/rate-limit');
    discoveryAppLimiter.reset();
    // Clé = nom d'app (après vérif HMAC) — pas IP. Isolation par secret.
    for (let i = 0; i < 30; i++) {
      expect(discoveryAppLimiter.enforce('notifuse').ok).toBe(true);
    }
    expect(discoveryAppLimiter.enforce('notifuse').ok).toBe(false);
    // Une autre app n'est pas affectée par l'épuisement de notifuse.
    expect(discoveryAppLimiter.enforce('prospection').ok).toBe(true);
    discoveryAppLimiter.reset();
  });
});

describe('shouldBypassRateLimit (E2E staging bypass)', () => {
  const ORIG_DEPLOY_ENV = process.env.DEPLOY_ENV;
  const ORIG_SECRET = process.env.E2E_RATELIMIT_BYPASS_SECRET;

  // Secret long ≥ 32 chars utilisé dans la majorité des cas.
  const GOOD_SECRET = 'a'.repeat(64);

  beforeEach(() => {
    process.env.DEPLOY_ENV = 'staging';
    process.env.E2E_RATELIMIT_BYPASS_SECRET = GOOD_SECRET;
  });

  afterAll(() => {
    if (ORIG_DEPLOY_ENV === undefined) delete process.env.DEPLOY_ENV;
    else process.env.DEPLOY_ENV = ORIG_DEPLOY_ENV;
    if (ORIG_SECRET === undefined) delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    else process.env.E2E_RATELIMIT_BYPASS_SECRET = ORIG_SECRET;
  });

  const make = (headers: Record<string, string>) => new Headers(headers);

  it('retourne true quand DEPLOY_ENV=staging + secret valide + header présent', () => {
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET })
      )
    ).toBe(true);
  });

  it('retourne true quand DEPLOY_ENV=local + secret valide + header présent', () => {
    process.env.DEPLOY_ENV = 'local';
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET })
      )
    ).toBe(true);
  });

  it('retourne true quand DEPLOY_ENV unset (≠ prod) + secret valide + header présent', () => {
    delete process.env.DEPLOY_ENV;
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET })
      )
    ).toBe(true);
  });

  it('GARDE-FOU PROD : retourne false en prod même avec header secret valide', () => {
    // C'est LE check le plus critique. Le header doit être ignoré en prod
    // peu importe sa valeur, sinon n'importe qui ayant le secret bypass
    // tout le rate-limit admin de prod.
    process.env.DEPLOY_ENV = 'prod';
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET })
      )
    ).toBe(false);
  });

  it('retourne false en prod même si secret undefined / longueur null', () => {
    process.env.DEPLOY_ENV = 'prod';
    delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': 'whatever' })
      )
    ).toBe(false);
  });

  it('retourne false quand le header est absent', () => {
    expect(shouldBypassRateLimit(make({}))).toBe(false);
  });

  it('retourne false quand le header secret est wrong (même longueur)', () => {
    // Même longueur que GOOD_SECRET → on tape timingSafeEqual qui doit
    // renvoyer false sans throw.
    const wrong = 'b'.repeat(64);
    expect(
      shouldBypassRateLimit(make({ 'x-veridian-e2e-bypass-ratelimit': wrong }))
    ).toBe(false);
  });

  it('retourne false quand le header secret est wrong (longueur différente)', () => {
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': 'too-short' })
      )
    ).toBe(false);
  });

  it("retourne false quand le secret env n'est pas configuré", () => {
    delete process.env.E2E_RATELIMIT_BYPASS_SECRET;
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': GOOD_SECRET })
      )
    ).toBe(false);
  });

  it("retourne false quand le secret env est vide ('')", () => {
    process.env.E2E_RATELIMIT_BYPASS_SECRET = '';
    expect(
      shouldBypassRateLimit(make({ 'x-veridian-e2e-bypass-ratelimit': '' }))
    ).toBe(false);
  });

  it('refuse un secret trop court (< 32 chars) même si match exact', () => {
    // Garde-fou n°2 : on impose ≥ 32 chars pour qu'un opérateur ne pose
    // pas un "secret" trivial type "test" ou "1234".
    const short = 'a'.repeat(31);
    process.env.E2E_RATELIMIT_BYPASS_SECRET = short;
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': short })
      )
    ).toBe(false);
  });

  it('accepte un secret pile à 32 chars (borne basse incluse)', () => {
    const justEnough = 'a'.repeat(32);
    process.env.E2E_RATELIMIT_BYPASS_SECRET = justEnough;
    expect(
      shouldBypassRateLimit(
        make({ 'x-veridian-e2e-bypass-ratelimit': justEnough })
      )
    ).toBe(true);
  });
});
