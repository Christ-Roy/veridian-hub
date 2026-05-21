/**
 * Mock OAuth provider Auth.js v5 — exclusivement pour les E2E sur staging.
 *
 * **POURQUOI** :
 *   Le flow OAuth réel (redirect vers Google/Microsoft, callback, échange
 *   de code) est impossible à scripter en CI sans humain dans la boucle.
 *   Du coup, aucun test E2E ne validait le scénario "OAuth signup →
 *   dashboard charge" → bug `supabaseUserId NULL` shippé en prod (cf.
 *   incident 2026-05-20→21).
 *
 *   Ce provider mocke uniquement la couche **identité** (qui est le user
 *   après OAuth) ; tout le reste du flow Auth.js (PrismaAdapter, callback
 *   signIn, event createUser, callback session/jwt) tourne pour de vrai.
 *
 * **GARDE-FOUS ANTI-BACKDOOR** (triple, défense en profondeur) :
 *
 *   1. **Activation requise** : OAUTH_TEST_PROVIDER=true ET DEPLOY_ENV=staging.
 *      Ni l'un ni l'autre ne suffit.
 *   2. **Refus prod** : si NODE_ENV=production OU DEPLOY_ENV=production,
 *      `assertSafeContext()` THROW au module load — Next.js refuse de boot.
 *   3. **CI invariant** : `scripts/ci/check-no-test-provider-in-prod.sh`
 *      grep le compose prod et fail si OAUTH_TEST_PROVIDER y apparaît.
 *
 * **USAGE en E2E** :
 *   POST /api/auth/callback/credentials avec :
 *     - mockProvider: 'google' | 'microsoft-entra-id'
 *     - email: 'test+oauth-google@e2e.veridian.site'
 *     - mockEmailVerified: 'true' | 'false'
 *
 *   → Le provider crée (ou retrouve) le user, crée un Account avec
 *     provider=<mockProvider>, puis Auth.js déclenche events.createUser
 *     EXACTEMENT comme un signup OAuth réel. C'est ce qui permet de
 *     tester le pont `supabaseUserId` end-to-end.
 */

import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';

const MOCK_INPUT_SCHEMA = z.object({
  email: z.string().email(),
  mockProvider: z.enum(['google', 'microsoft-entra-id']),
  mockEmailVerified: z.enum(['true', 'false']).optional(),
});

/**
 * Throw immédiatement si on tente d'activer le provider en prod.
 * Appelé au module load — Next.js refuse de boot si la combinaison est dangereuse.
 */
export function assertSafeContext(env: NodeJS.ProcessEnv = process.env): void {
  if (env.OAUTH_TEST_PROVIDER !== 'true') return;

  if (env.NODE_ENV === 'production' || env.DEPLOY_ENV === 'production') {
    throw new Error(
      '[mock-oauth-provider] FATAL: OAUTH_TEST_PROVIDER=true with ' +
        `NODE_ENV=${env.NODE_ENV} / DEPLOY_ENV=${env.DEPLOY_ENV} — refusing to boot. ` +
        'Mock OAuth provider must NEVER run in production.',
    );
  }

  if (env.DEPLOY_ENV !== 'staging' && env.NODE_ENV !== 'test' && env.NODE_ENV !== 'development') {
    throw new Error(
      '[mock-oauth-provider] FATAL: OAUTH_TEST_PROVIDER=true with ' +
        `DEPLOY_ENV=${env.DEPLOY_ENV} NODE_ENV=${env.NODE_ENV} — ` +
        'mock provider only allowed on staging or local dev/test.',
    );
  }
}

/**
 * Détermine si le mock provider doit être branché.
 * Pure function — appelée par auth.ts au démarrage.
 */
export function isMockOauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OAUTH_TEST_PROVIDER !== 'true') return false;
  if (env.NODE_ENV === 'production' || env.DEPLOY_ENV === 'production') return false;
  // Staging OU local dev/test
  return env.DEPLOY_ENV === 'staging' || env.NODE_ENV === 'test' || env.NODE_ENV === 'development';
}

export type MockOauthDeps = {
  prisma: Pick<PrismaClient, 'user' | 'account'>;
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
};

/**
 * Factory du provider Credentials mocké. Reproduit ce que le PrismaAdapter
 * + OAuth provider Google/Microsoft auraient fait, sans appel réseau externe.
 *
 * **Ne PAS exporter directement** — passer par `buildMockOauthProvider()`
 * qui appelle `assertSafeContext()` d'abord.
 */
function buildProvider({ prisma, logger = console }: MockOauthDeps) {
  return Credentials({
    id: 'mock-oauth',
    name: 'Mock OAuth (E2E only)',
    credentials: {
      email: { label: 'Email', type: 'email' },
      mockProvider: { label: 'Mock provider', type: 'text' },
      mockEmailVerified: { label: 'Email verified', type: 'text' },
    },
    async authorize(credentials) {
      // Re-vérifie au call site — défense en profondeur n°4.
      // Si quelqu'un parvient à activer le provider en prod par accident,
      // chaque login est encore refusé.
      if (!isMockOauthEnabled()) {
        logger.warn('[mock-oauth-provider] authorize() called but env not safe — denying');
        return null;
      }

      const parsed = MOCK_INPUT_SCHEMA.safeParse(credentials);
      if (!parsed.success) return null;
      const { email, mockProvider, mockEmailVerified } = parsed.data;

      // Reproduit le comportement du PrismaAdapter OAuth :
      // 1. Cherche un user par email (avec allowDangerousEmailAccountLinking
      //    actif côté Google/Microsoft, le link est automatique).
      // 2. Si absent, crée un user avec uniquement les champs que le
      //    PrismaAdapter aurait posé. **supabaseUserId reste NULL** — c'est
      //    exactement le bug d'hier qu'on veut tester. L'event createUser
      //    le patche après.
      // 3. Crée la row Account si elle n'existe pas (provider=<mockProvider>).
      let user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true },
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            email,
            emailVerified: mockEmailVerified === 'true' ? new Date() : null,
            // PAS de supabaseUserId — on veut que events.createUser le pose.
          },
          select: { id: true, email: true },
        });
      }

      // Cherche/crée l'Account pour ce provider
      const existingAccount = await prisma.account.findUnique({
        where: {
          provider_providerAccountId: {
            provider: mockProvider,
            providerAccountId: email,
          },
        },
        select: { id: true },
      });

      if (!existingAccount) {
        await prisma.account.create({
          data: {
            userId: user.id,
            type: 'oauth',
            provider: mockProvider,
            providerAccountId: email,
          },
        });
      }

      logger.info?.(
        JSON.stringify({
          tag: '[mock-oauth-provider]',
          level: 'info',
          message: 'mock OAuth login',
          email,
          provider: mockProvider,
          userId: user.id,
          ts: new Date().toISOString(),
        }),
      );

      return { id: user.id, email: user.email, name: null, image: null };
    },
  });
}

/**
 * Fabrique le provider — vérifie la sécurité d'abord, puis construit.
 * Si l'env n'autorise pas le mock, renvoie `null` — l'appelant doit gérer.
 */
export function buildMockOauthProvider(deps: MockOauthDeps) {
  assertSafeContext();
  if (!isMockOauthEnabled()) return null;
  return buildProvider(deps);
}
