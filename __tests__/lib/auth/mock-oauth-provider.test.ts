/**
 * Tests du mock OAuth provider — focus 100% sur les garde-fous anti-backdoor.
 *
 * Si ce provider fuit en prod, c'est une auth bypass critique. Donc 80% des
 * tests valident que le provider REFUSE de s'activer dans tous les contextes
 * inappropriés.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  assertSafeContext,
  isMockOauthEnabled,
  buildMockOauthProvider,
} from '@/lib/auth/mock-oauth-provider';

describe('mock-oauth-provider — garde-fous sécurité', () => {
  describe('assertSafeContext()', () => {
    it('no-op si OAUTH_TEST_PROVIDER absent (cas prod par défaut)', () => {
      expect(() => assertSafeContext({} as NodeJS.ProcessEnv)).not.toThrow();
      expect(() => assertSafeContext({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).not.toThrow();
      expect(() => assertSafeContext({ DEPLOY_ENV: 'production' } as NodeJS.ProcessEnv)).not.toThrow();
    });

    it('THROW si OAUTH_TEST_PROVIDER=true ET DEPLOY_ENV=production', () => {
      // C'est LA seule variable qui distingue staging/prod côté Veridian
      // (NODE_ENV=production tout le temps en build optimisé Next.js).
      expect(() =>
        assertSafeContext({
          OAUTH_TEST_PROVIDER: 'true',
          DEPLOY_ENV: 'production',
        } as NodeJS.ProcessEnv),
      ).toThrow(/refusing to boot/);
    });

    it('THROW si OAUTH_TEST_PROVIDER=true ET DEPLOY_ENV=production même avec NODE_ENV=test', () => {
      expect(() =>
        assertSafeContext({
          OAUTH_TEST_PROVIDER: 'true',
          DEPLOY_ENV: 'production',
          NODE_ENV: 'test',
        } as NodeJS.ProcessEnv),
      ).toThrow(/refusing to boot/);
    });

    it('THROW si OAUTH_TEST_PROVIDER=true sans DEPLOY_ENV/NODE_ENV explicite (= contexte ambigu)', () => {
      expect(() =>
        assertSafeContext({
          OAUTH_TEST_PROVIDER: 'true',
        } as NodeJS.ProcessEnv),
      ).toThrow(/only allowed on staging \(DEPLOY_ENV=staging\) or local dev\/test/);
    });

    it('THROW si OAUTH_TEST_PROVIDER=true avec NODE_ENV=production seul (DEPLOY_ENV absent — ambigu)', () => {
      expect(() =>
        assertSafeContext({
          OAUTH_TEST_PROVIDER: 'true',
          NODE_ENV: 'production',
        } as NodeJS.ProcessEnv),
      ).toThrow(/only allowed on staging/);
    });

    it('OK si OAUTH_TEST_PROVIDER=true ET DEPLOY_ENV=staging même avec NODE_ENV=production (build Next.js)', () => {
      // C'est précisément le cas du container staging : build prod Next.js
      // (NODE_ENV=production) avec override DEPLOY_ENV=staging. Doit passer.
      expect(() =>
        assertSafeContext({
          OAUTH_TEST_PROVIDER: 'true',
          DEPLOY_ENV: 'staging',
          NODE_ENV: 'production',
        } as NodeJS.ProcessEnv),
      ).not.toThrow();
    });

    it('OK si OAUTH_TEST_PROVIDER=true ET DEPLOY_ENV=staging', () => {
      expect(() =>
        assertSafeContext({
          OAUTH_TEST_PROVIDER: 'true',
          DEPLOY_ENV: 'staging',
        } as NodeJS.ProcessEnv),
      ).not.toThrow();
    });

    it('OK si OAUTH_TEST_PROVIDER=true ET NODE_ENV=test', () => {
      expect(() =>
        assertSafeContext({
          OAUTH_TEST_PROVIDER: 'true',
          NODE_ENV: 'test',
        } as NodeJS.ProcessEnv),
      ).not.toThrow();
    });

    it('OK si OAUTH_TEST_PROVIDER=true ET NODE_ENV=development', () => {
      expect(() =>
        assertSafeContext({
          OAUTH_TEST_PROVIDER: 'true',
          NODE_ENV: 'development',
        } as NodeJS.ProcessEnv),
      ).not.toThrow();
    });
  });

  describe('isMockOauthEnabled()', () => {
    it('false si flag absent', () => {
      expect(isMockOauthEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    });

    it('false si DEPLOY_ENV=production même avec flag', () => {
      expect(
        isMockOauthEnabled({
          OAUTH_TEST_PROVIDER: 'true',
          DEPLOY_ENV: 'production',
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    });

    it('true si DEPLOY_ENV=staging même avec NODE_ENV=production (cas réel du container staging)', () => {
      expect(
        isMockOauthEnabled({
          OAUTH_TEST_PROVIDER: 'true',
          DEPLOY_ENV: 'staging',
          NODE_ENV: 'production',
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    });

    it('false si NODE_ENV=production seul (sans DEPLOY_ENV override) = contexte ambigu', () => {
      expect(
        isMockOauthEnabled({
          OAUTH_TEST_PROVIDER: 'true',
          NODE_ENV: 'production',
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    });

    it('true si flag + DEPLOY_ENV=staging', () => {
      expect(
        isMockOauthEnabled({
          OAUTH_TEST_PROVIDER: 'true',
          DEPLOY_ENV: 'staging',
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    });

    it('true si flag + NODE_ENV=test', () => {
      expect(
        isMockOauthEnabled({
          OAUTH_TEST_PROVIDER: 'true',
          NODE_ENV: 'test',
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    });

    it('true si flag + NODE_ENV=development', () => {
      expect(
        isMockOauthEnabled({
          OAUTH_TEST_PROVIDER: 'true',
          NODE_ENV: 'development',
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    });
  });

  describe('buildMockOauthProvider()', () => {
    function makePrisma() {
      const user = {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async (args: { data: { email: string } }) => ({
          id: 'mock-id',
          email: args.data.email,
        })),
      };
      const account = {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: 'acc-id' })),
      };
      return { user, account } as never;
    }

    it('renvoie null si l\'env n\'autorise pas le mock (pas dans NODE_ENV=test si vitest restore l\'env)', () => {
      // process.env est partagé entre tests Vitest. On force un env safe puis on flip OAUTH_TEST_PROVIDER off.
      const prev = process.env.OAUTH_TEST_PROVIDER;
      delete process.env.OAUTH_TEST_PROVIDER;
      try {
        const provider = buildMockOauthProvider({ prisma: makePrisma() });
        expect(provider).toBeNull();
      } finally {
        if (prev !== undefined) process.env.OAUTH_TEST_PROVIDER = prev;
      }
    });

    it('renvoie un provider Auth.js valide quand OAUTH_TEST_PROVIDER=true en NODE_ENV=test', () => {
      const prev = process.env.OAUTH_TEST_PROVIDER;
      process.env.OAUTH_TEST_PROVIDER = 'true';
      try {
        const provider = buildMockOauthProvider({ prisma: makePrisma() });
        expect(provider).not.toBeNull();
        // Auth.js v5 stocke la config utilisateur dans `provider.options`.
        // L'id custom passé au constructor finit dans options.id, pas au
        // top-level (qui garde le type 'credentials').
        const resolved = typeof provider === 'function' ? provider({}) : provider;
        const opts = (resolved as { options?: { id?: string } })?.options ?? {};
        expect(opts.id).toBe('mock-oauth');
      } finally {
        if (prev !== undefined) process.env.OAUTH_TEST_PROVIDER = prev;
        else delete process.env.OAUTH_TEST_PROVIDER;
      }
    });
  });
});
