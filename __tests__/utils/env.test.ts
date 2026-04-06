import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to re-import after each env change
const loadEnvModule = async () => {
  // Clear module cache
  vi.resetModules();
  return import('@/utils/env');
};

describe('utils/env', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getEnvironment', () => {
    it('returns development when DOMAIN contains dev.veridian.site', async () => {
      process.env.DOMAIN = 'dev.veridian.site';
      const { getEnvironment } = await loadEnvModule();
      expect(getEnvironment()).toBe('development');
    });

    it('returns development when DOMAIN contains localhost', async () => {
      process.env.DOMAIN = 'localhost';
      const { getEnvironment } = await loadEnvModule();
      expect(getEnvironment()).toBe('development');
    });

    it('returns production when DOMAIN is app.veridian.site', async () => {
      process.env.DOMAIN = 'app.veridian.site';
      const { getEnvironment } = await loadEnvModule();
      expect(getEnvironment()).toBe('production');
    });

    it('falls back to NODE_ENV when DOMAIN is not set', async () => {
      delete process.env.DOMAIN;
      delete process.env.NEXT_PUBLIC_DOMAIN;
      delete process.env.NEXT_PUBLIC_SITE_URL;
      process.env.NODE_ENV = 'production';
      const { getEnvironment } = await loadEnvModule();
      expect(getEnvironment()).toBe('production');
    });

    it('defaults to development when nothing is set', async () => {
      delete process.env.DOMAIN;
      delete process.env.NEXT_PUBLIC_DOMAIN;
      delete process.env.NEXT_PUBLIC_SITE_URL;
      process.env.NODE_ENV = 'development';
      const { getEnvironment } = await loadEnvModule();
      expect(getEnvironment()).toBe('development');
    });

    it('checks NEXT_PUBLIC_SITE_URL as fallback', async () => {
      delete process.env.DOMAIN;
      delete process.env.NEXT_PUBLIC_DOMAIN;
      process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
      const { getEnvironment } = await loadEnvModule();
      expect(getEnvironment()).toBe('production');
    });
  });

  describe('isProduction / isDevelopment', () => {
    it('isProduction returns true in production', async () => {
      process.env.DOMAIN = 'app.veridian.site';
      const { isProduction } = await loadEnvModule();
      expect(isProduction()).toBe(true);
    });

    it('isDevelopment returns true in development', async () => {
      process.env.DOMAIN = 'dev.veridian.site';
      const { isDevelopment } = await loadEnvModule();
      expect(isDevelopment()).toBe(true);
    });
  });

  describe('getEnvironmentLabel', () => {
    it('returns PRODUCTION for production env', async () => {
      process.env.DOMAIN = 'app.veridian.site';
      const { getEnvironmentLabel } = await loadEnvModule();
      expect(getEnvironmentLabel()).toBe('PRODUCTION');
    });

    it('returns DEVELOPMENT for dev env', async () => {
      process.env.DOMAIN = 'dev.veridian.site';
      const { getEnvironmentLabel } = await loadEnvModule();
      expect(getEnvironmentLabel()).toBe('DEVELOPMENT');
    });
  });

  describe('getStripeKey', () => {
    it('returns test key in development', async () => {
      process.env.DOMAIN = 'dev.veridian.site';
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      process.env.STRIPE_SECRET_KEY_LIVE = 'sk_live_456';
      const { getStripeKey } = await loadEnvModule();
      expect(getStripeKey()).toBe('sk_test_123');
    });

    it('returns live key in production', async () => {
      process.env.DOMAIN = 'app.veridian.site';
      process.env.STRIPE_SECRET_KEY = 'sk_test_123';
      process.env.STRIPE_SECRET_KEY_LIVE = 'sk_live_456';
      const { getStripeKey } = await loadEnvModule();
      expect(getStripeKey()).toBe('sk_live_456');
    });

    it('throws when key is missing', async () => {
      process.env.DOMAIN = 'dev.veridian.site';
      delete process.env.STRIPE_SECRET_KEY;
      const { getStripeKey } = await loadEnvModule();
      expect(() => getStripeKey()).toThrow('Clé Stripe non trouvée');
    });
  });

  describe('getStripeWebhookSecret', () => {
    it('returns test webhook secret in development', async () => {
      process.env.DOMAIN = 'dev.veridian.site';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123';
      const { getStripeWebhookSecret } = await loadEnvModule();
      expect(getStripeWebhookSecret()).toBe('whsec_test_123');
    });

    it('throws when secret is missing', async () => {
      process.env.DOMAIN = 'dev.veridian.site';
      delete process.env.STRIPE_WEBHOOK_SECRET;
      const { getStripeWebhookSecret } = await loadEnvModule();
      expect(() => getStripeWebhookSecret()).toThrow('Secret webhook Stripe non trouvé');
    });
  });

  describe('getStripePublishableKey', () => {
    it('returns test publishable key in development', async () => {
      process.env.DOMAIN = 'dev.veridian.site';
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
      const { getStripePublishableKey } = await loadEnvModule();
      expect(getStripePublishableKey()).toBe('pk_test_123');
    });

    it('returns live publishable key in production', async () => {
      process.env.DOMAIN = 'app.veridian.site';
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE = 'pk_live_456';
      const { getStripePublishableKey } = await loadEnvModule();
      expect(getStripePublishableKey()).toBe('pk_live_456');
    });
  });
});
