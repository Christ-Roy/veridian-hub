/**
 * Tests du mock OAuth provider — focus 100% sur les garde-fous anti-backdoor.
 *
 * Si ce provider fuit en prod, c'est une auth bypass critique. Donc 80% des
 * tests valident que le provider REFUSE de s'activer dans tous les contextes
 * inappropriés.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock provisionDefaultWorkspace : on vérifie que le mock OAuth l'invoque
// (miroir de l'event createUser réel). Sans ça, les users mock OAuth
// n'avaient pas de workspace → A-01/A-02/J-01 E2E rouges (2026-05-29).
const provisionWorkspaceMock = vi.hoisted(() => vi.fn(async () => ({
  workspaceId: 'ws-mock',
  created: true,
})));
vi.mock('@/lib/workspace/provision', () => ({
  provisionDefaultWorkspace: provisionWorkspaceMock,
}));

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
      const createdUsers: Array<{ data: Record<string, unknown> }> = [];
      const user = {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async (args: { data: { email: string; supabaseUserId?: string } }) => {
          createdUsers.push({ data: args.data });
          return {
            id: 'mock-id',
            email: args.data.email,
          };
        }),
      };
      const account = {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: 'acc-id' })),
      };
      return { prisma: { user, account } as never, createdUsers };
    }

    it('renvoie null si l\'env n\'autorise pas le mock (pas dans NODE_ENV=test si vitest restore l\'env)', () => {
      // process.env est partagé entre tests Vitest. On force un env safe puis on flip OAUTH_TEST_PROVIDER off.
      const prev = process.env.OAUTH_TEST_PROVIDER;
      delete process.env.OAUTH_TEST_PROVIDER;
      try {
        const { prisma } = makePrisma();
        const provider = buildMockOauthProvider({ prisma });
        expect(provider).toBeNull();
      } finally {
        if (prev !== undefined) process.env.OAUTH_TEST_PROVIDER = prev;
      }
    });

    it('renvoie un provider Auth.js valide quand OAUTH_TEST_PROVIDER=true en NODE_ENV=test', () => {
      const prev = process.env.OAUTH_TEST_PROVIDER;
      process.env.OAUTH_TEST_PROVIDER = 'true';
      try {
        const { prisma } = makePrisma();
        const provider = buildMockOauthProvider({ prisma });
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

    // ─── BUG-2026-05-21 : non-régression supabaseUserId ────────────────────
    //
    // Le mock provider est un Credentials provider Auth.js. Auth.js v5 NE
    // déclenche PAS `events.createUser` pour les Credentials providers
    // (uniquement pour OAuth via PrismaAdapter). Donc le user créé via
    // `prisma.user.create()` dans le mock doit poser `supabaseUserId`
    // LUI-MÊME — sinon Dashboard crash sur userUuid().
    //
    // Détecté par le test E2E `06-provisioning-cross-app.spec.ts` (journey 6).
    // Fixé en posant `supabaseUserId: generateUuid()` dans le `data` du
    // `prisma.user.create()`.
    it('BUG-2026-05-21 : pose supabaseUserId UUID v4 sur user fraîchement créé via mock OAuth', async () => {
      const prev = process.env.OAUTH_TEST_PROVIDER;
      process.env.OAUTH_TEST_PROVIDER = 'true';
      try {
        const { prisma, createdUsers } = makePrisma();
        const provider = buildMockOauthProvider({ prisma });
        expect(provider).not.toBeNull();

        // Récupérer authorize() depuis la config provider (Auth.js v5 stocke
        // dans `.options` quand on appelle Credentials({...})).
        const resolved = typeof provider === 'function' ? provider({}) : provider;
        const authorize = (resolved as { options?: { authorize?: (creds: unknown) => Promise<unknown> } })
          .options?.authorize;
        expect(typeof authorize).toBe('function');

        const result = await authorize!({
          email: 'mock-new@e2e.veridian.site',
          mockProvider: 'google',
          mockEmailVerified: 'true',
        });
        expect(result).toMatchObject({ id: 'mock-id', email: 'mock-new@e2e.veridian.site' });

        // 1 user créé — assertion centrale.
        expect(createdUsers).toHaveLength(1);
        const data = createdUsers[0].data;
        expect(
          data.supabaseUserId,
          'BUG-2026-05-21 : mock OAuth doit poser supabaseUserId UUID v4 (sinon Dashboard 500)',
        ).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      } finally {
        if (prev !== undefined) process.env.OAUTH_TEST_PROVIDER = prev;
        else delete process.env.OAUTH_TEST_PROVIDER;
      }
    });

    it('provisionne le workspace par défaut via mock OAuth (miroir event createUser, fix 2026-05-29)', async () => {
      const prev = process.env.OAUTH_TEST_PROVIDER;
      process.env.OAUTH_TEST_PROVIDER = 'true';
      provisionWorkspaceMock.mockClear();
      try {
        const { prisma } = makePrisma();
        const provider = buildMockOauthProvider({ prisma });
        const resolved = typeof provider === 'function' ? provider({}) : provider;
        const authorize = (resolved as { options?: { authorize?: (creds: unknown) => Promise<unknown> } })
          .options?.authorize;

        await authorize!({
          email: 'mock-ws@e2e.veridian.site',
          mockProvider: 'google',
          mockEmailVerified: 'true',
        });

        // Le mock DOIT appeler provisionDefaultWorkspace avec le user fraîchement
        // créé — sinon les signups mock OAuth n'ont pas de workspace (régression
        // A-01/A-02/J-01 E2E).
        expect(provisionWorkspaceMock).toHaveBeenCalledTimes(1);
        expect(provisionWorkspaceMock).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 'mock-id', email: 'mock-ws@e2e.veridian.site' }),
          expect.objectContaining({ actor: 'system:mock-oauth-signup' }),
        );
        // Le 2e arg (deps) ne passe PAS de `logger` custom : le logger du mock
        // n'a que {warn,info}, or provision veut {error,info} → on laisse le
        // défaut console (sinon type error au build, attrapée 2026-05-29).
        const deps = provisionWorkspaceMock.mock.calls[0][1] as Record<string, unknown>;
        expect(deps).not.toHaveProperty('logger');
      } finally {
        if (prev !== undefined) process.env.OAUTH_TEST_PROVIDER = prev;
        else delete process.env.OAUTH_TEST_PROVIDER;
      }
    });

    it('NE crée PAS un nouveau user si findUnique retourne un user existant (link auto comme allowDangerousEmailAccountLinking)', async () => {
      const prev = process.env.OAUTH_TEST_PROVIDER;
      process.env.OAUTH_TEST_PROVIDER = 'true';
      try {
        const { prisma, createdUsers } = makePrisma();
        // Override findUnique pour retourner un user existant.
        (prisma as { user: { findUnique: ReturnType<typeof vi.fn> } }).user.findUnique = vi.fn(
          async () => ({ id: 'existing-id', email: 'existing@e2e.veridian.site' }),
        );

        const provider = buildMockOauthProvider({ prisma });
        const resolved = typeof provider === 'function' ? provider({}) : provider;
        const authorize = (resolved as { options?: { authorize?: (creds: unknown) => Promise<unknown> } })
          .options?.authorize;

        await authorize!({
          email: 'existing@e2e.veridian.site',
          mockProvider: 'microsoft-entra-id',
          mockEmailVerified: 'true',
        });

        // findUnique a trouvé → on ne crée PAS de nouveau user.
        expect(createdUsers).toHaveLength(0);
      } finally {
        if (prev !== undefined) process.env.OAUTH_TEST_PROVIDER = prev;
        else delete process.env.OAUTH_TEST_PROVIDER;
      }
    });

    it('generateUuid injectable — permet UUID déterministe pour tests', async () => {
      const prev = process.env.OAUTH_TEST_PROVIDER;
      process.env.OAUTH_TEST_PROVIDER = 'true';
      try {
        const fixedUuid = '11111111-2222-4333-8444-555555555555';
        const { prisma, createdUsers } = makePrisma();
        const provider = buildMockOauthProvider({
          prisma,
          generateUuid: () => fixedUuid,
        });
        const resolved = typeof provider === 'function' ? provider({}) : provider;
        const authorize = (resolved as { options?: { authorize?: (creds: unknown) => Promise<unknown> } })
          .options?.authorize;

        await authorize!({
          email: 'mock-fixed@e2e.veridian.site',
          mockProvider: 'google',
          mockEmailVerified: 'true',
        });

        expect(createdUsers[0].data.supabaseUserId).toBe(fixedUuid);
      } finally {
        if (prev !== undefined) process.env.OAUTH_TEST_PROVIDER = prev;
        else delete process.env.OAUTH_TEST_PROVIDER;
      }
    });
  });
});
