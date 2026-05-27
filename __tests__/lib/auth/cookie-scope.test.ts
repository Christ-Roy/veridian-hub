import { describe, it, expect } from 'vitest';
import {
  resolveSessionCookieDomain,
  resolveSessionCookieName,
  resolveSessionCookieConfig,
} from '@/lib/auth/cookie-scope';

describe('resolveSessionCookieDomain', () => {
  it('renvoie .veridian.site quand DEPLOY_ENV=prod', () => {
    expect(resolveSessionCookieDomain({ DEPLOY_ENV: 'prod' })).toBe('.veridian.site');
  });

  it('renvoie .staging.veridian.site quand DEPLOY_ENV=staging', () => {
    expect(resolveSessionCookieDomain({ DEPLOY_ENV: 'staging' })).toBe('.staging.veridian.site');
  });

  it('renvoie undefined quand DEPLOY_ENV absent (local-dev)', () => {
    expect(resolveSessionCookieDomain({})).toBeUndefined();
  });

  it('renvoie undefined pour DEPLOY_ENV inconnu (préprod / test runner)', () => {
    expect(resolveSessionCookieDomain({ DEPLOY_ENV: 'preprod' })).toBeUndefined();
    expect(resolveSessionCookieDomain({ DEPLOY_ENV: 'test' })).toBeUndefined();
  });

  it("ne se base PAS sur NODE_ENV (piège staging build prod, cf. memory feedback_node_env_vs_deploy_env)", () => {
    // NODE_ENV=production en staging (build Next.js) ne doit pas faire matcher .veridian.site
    expect(resolveSessionCookieDomain({ NODE_ENV: 'production' })).toBeUndefined();
  });
});

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

describe('resolveSessionCookieConfig', () => {
  it('config prod : __Secure-, secure:true, domain:.veridian.site', () => {
    const config = resolveSessionCookieConfig({ DEPLOY_ENV: 'prod', NODE_ENV: 'production' });
    expect(config?.sessionToken).toEqual({
      name: '__Secure-authjs.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: true,
        domain: '.veridian.site',
      },
    });
  });

  it('config staging : __Secure-, secure:true, domain:.staging.veridian.site', () => {
    const config = resolveSessionCookieConfig({ DEPLOY_ENV: 'staging', NODE_ENV: 'production' });
    expect(config?.sessionToken?.options?.domain).toBe('.staging.veridian.site');
    expect(config?.sessionToken?.options?.secure).toBe(true);
    expect(config?.sessionToken?.name).toBe('__Secure-authjs.session-token');
  });

  it('config local-dev : pas de préfixe, secure:false, domain:undefined', () => {
    const config = resolveSessionCookieConfig({ NODE_ENV: 'development' });
    expect(config?.sessionToken?.options?.domain).toBeUndefined();
    expect(config?.sessionToken?.options?.secure).toBe(false);
    expect(config?.sessionToken?.name).toBe('authjs.session-token');
  });

  it("garde httpOnly + sameSite:'lax' + path:'/' dans tous les envs", () => {
    for (const env of [
      { DEPLOY_ENV: 'prod', NODE_ENV: 'production' },
      { DEPLOY_ENV: 'staging', NODE_ENV: 'production' },
      { NODE_ENV: 'development' },
    ]) {
      const config = resolveSessionCookieConfig(env);
      expect(config?.sessionToken?.options?.httpOnly).toBe(true);
      expect(config?.sessionToken?.options?.sameSite).toBe('lax');
      expect(config?.sessionToken?.options?.path).toBe('/');
    }
  });
});
