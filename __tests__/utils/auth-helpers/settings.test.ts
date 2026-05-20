/**
 * Tests pour `utils/auth-helpers/settings.ts`.
 *
 * Garde-fou contre 2 régressions silencieuses :
 *  1. `allowEmail` ou `allowPassword` désactivés sans intention (lock-out user)
 *  2. `allowOauth` activé côté staging Tailscale-only (red flag providers OAuth,
 *     cf. memory feedback_oauth_pas_sur_staging_tailscale.md)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('utils/auth-helpers/settings — getAuthTypes()', () => {
  const ORIGINAL_DEPLOY_ENV = process.env.DEPLOY_ENV;

  afterEach(() => {
    process.env.DEPLOY_ENV = ORIGINAL_DEPLOY_ENV;
    vi.resetModules();
  });

  it('en prod (DEPLOY_ENV=prod), tous les flags sont actifs', async () => {
    process.env.DEPLOY_ENV = 'prod';
    vi.resetModules();
    const { getAuthTypes } = await import('@/utils/auth-helpers/settings');
    const a = getAuthTypes();
    expect(a.allowOauth).toBe(true);
    expect(a.allowEmail).toBe(true);
    expect(a.allowPassword).toBe(true);
  });

  it('en staging Tailscale-only (DEPLOY_ENV=staging), allowOauth est désactivé', async () => {
    process.env.DEPLOY_ENV = 'staging';
    vi.resetModules();
    const { getAuthTypes } = await import('@/utils/auth-helpers/settings');
    const a = getAuthTypes();
    expect(a.allowOauth).toBe(false);
    // Credentials + magic link doivent rester actifs en staging
    expect(a.allowEmail).toBe(true);
    expect(a.allowPassword).toBe(true);
  });

  it('sans DEPLOY_ENV défini (build local-dev), OAuth est activé', async () => {
    delete process.env.DEPLOY_ENV;
    vi.resetModules();
    const { getAuthTypes } = await import('@/utils/auth-helpers/settings');
    expect(getAuthTypes().allowOauth).toBe(true);
  });

  it('en green (DEPLOY_ENV=green, déploiement blue-green), OAuth actif', async () => {
    process.env.DEPLOY_ENV = 'green';
    vi.resetModules();
    const { getAuthTypes } = await import('@/utils/auth-helpers/settings');
    expect(getAuthTypes().allowOauth).toBe(true);
  });
});

describe('utils/auth-helpers/settings — getViewTypes()', () => {
  it('inclut signup + password_signin + forgot_password + email_signin', async () => {
    process.env.DEPLOY_ENV = 'prod';
    vi.resetModules();
    const { getViewTypes } = await import('@/utils/auth-helpers/settings');
    const v = getViewTypes();
    expect(v).toContain('signup');
    expect(v).toContain('password_signin');
    expect(v).toContain('forgot_password');
    expect(v).toContain('email_signin');
  });
});

describe('utils/auth-helpers/settings — getDefaultSignInView()', () => {
  it('par défaut renvoie password_signin', async () => {
    process.env.DEPLOY_ENV = 'prod';
    vi.resetModules();
    const { getDefaultSignInView } = await import('@/utils/auth-helpers/settings');
    expect(getDefaultSignInView(null)).toBe('password_signin');
  });

  it('respecte la préférence user si valide', async () => {
    process.env.DEPLOY_ENV = 'prod';
    vi.resetModules();
    const { getDefaultSignInView } = await import('@/utils/auth-helpers/settings');
    expect(getDefaultSignInView('email_signin')).toBe('email_signin');
  });

  it('ignore la préférence user si invalide', async () => {
    process.env.DEPLOY_ENV = 'prod';
    vi.resetModules();
    const { getDefaultSignInView } = await import('@/utils/auth-helpers/settings');
    expect(getDefaultSignInView('totally_invalid')).toBe('password_signin');
  });
});
