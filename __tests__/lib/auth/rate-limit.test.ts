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
 */

import { describe, it, expect } from 'vitest';
import { RateLimiter, extractClientIp } from '@/lib/auth/rate-limit';

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
});
