import { describe, it, expect } from 'vitest';
import {
  resolveSessionCookieName,
  resolveHintCookieDomain,
} from '@/lib/auth/cookie-scope';

describe('resolveSessionCookieName', () => {
  it('préfixe __Secure- en production build (NODE_ENV=production)', () => {
    expect(resolveSessionCookieName({ NODE_ENV: 'production' })).toBe(
      '__Secure-authjs.session-token',
    );
  });

  it('pas de préfixe en dev (NODE_ENV=development)', () => {
    expect(resolveSessionCookieName({ NODE_ENV: 'development' })).toBe('authjs.session-token');
  });

  it('pas de préfixe en test', () => {
    expect(resolveSessionCookieName({ NODE_ENV: 'test' })).toBe('authjs.session-token');
  });
});

describe('resolveHintCookieDomain (cookie HINT cross-subdomain — pas le sessionToken)', () => {
  it('renvoie .veridian.site quand DEPLOY_ENV=prod', () => {
    expect(resolveHintCookieDomain({ DEPLOY_ENV: 'prod' })).toBe('.veridian.site');
  });

  it('renvoie .staging.veridian.site quand DEPLOY_ENV=staging', () => {
    expect(resolveHintCookieDomain({ DEPLOY_ENV: 'staging' })).toBe('.staging.veridian.site');
  });

  it('renvoie undefined quand DEPLOY_ENV absent (local-dev)', () => {
    expect(resolveHintCookieDomain({})).toBeUndefined();
  });

  it('renvoie undefined pour DEPLOY_ENV inconnu (préprod / test runner)', () => {
    expect(resolveHintCookieDomain({ DEPLOY_ENV: 'preprod' })).toBeUndefined();
    expect(resolveHintCookieDomain({ DEPLOY_ENV: 'test' })).toBeUndefined();
  });

  it("ne se base PAS sur NODE_ENV (piège staging build prod, cf. memory feedback_node_env_vs_deploy_env)", () => {
    // NODE_ENV=production en staging (build Next.js) ne doit pas faire matcher .veridian.site
    expect(resolveHintCookieDomain({ NODE_ENV: 'production' })).toBeUndefined();
  });
});
