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

import { randomUUID } from 'node:crypto';
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
 *
 * NOTE : on se base sur `DEPLOY_ENV` (variable applicative Veridian) et PAS
 * sur `NODE_ENV`. Pourquoi : un build Next.js optimisé tourne avec
 * `NODE_ENV=production` même en staging (c'est ce qu'on shippe via Docker).
 * Donc la seule variable fiable pour distinguer staging vs prod est
 * `DEPLOY_ENV=staging` (injecté dans compose/staging.yml) vs
 * `DEPLOY_ENV=production` (injecté dans compose/prod.yml).
 *
 * Garde-fou bonus : si DEPLOY_ENV est absent OU vaut "production", on refuse.
 * → impossible d'activer le mock par oubli d'override (default-safe).
 */
export function assertSafeContext(env: NodeJS.ProcessEnv = process.env): void {
  if (env.OAUTH_TEST_PROVIDER !== 'true') return;

  // DEPLOY_ENV=production → refus catégorique
  if (env.DEPLOY_ENV === 'production') {
    throw new Error(
      '[mock-oauth-provider] FATAL: OAUTH_TEST_PROVIDER=true with ' +
        `DEPLOY_ENV=production — refusing to boot. ` +
        'Mock OAuth provider must NEVER run in production.',
    );
  }

  // Combinaisons autorisées :
  //   - DEPLOY_ENV=staging (staging dev server)
  //   - NODE_ENV=test (tests vitest — DEPLOY_ENV souvent absent)
  //   - NODE_ENV=development (pnpm dev local — DEPLOY_ENV souvent absent)
  // Toute autre combinaison (ex: DEPLOY_ENV absent en NODE_ENV=production) refuse.
  const allowed =
    env.DEPLOY_ENV === 'staging' ||
    env.NODE_ENV === 'test' ||
    env.NODE_ENV === 'development';

  if (!allowed) {
    throw new Error(
      '[mock-oauth-provider] FATAL: OAUTH_TEST_PROVIDER=true with ' +
        `DEPLOY_ENV=${env.DEPLOY_ENV} NODE_ENV=${env.NODE_ENV} — ` +
        'mock provider only allowed on staging (DEPLOY_ENV=staging) or local dev/test.',
    );
  }
}

/**
 * Détermine si le mock provider doit être branché.
 * Pure function — appelée par auth.ts au démarrage.
 */
export function isMockOauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OAUTH_TEST_PROVIDER !== 'true') return false;
  if (env.DEPLOY_ENV === 'production') return false;
  // Staging OU local dev/test
  return (
    env.DEPLOY_ENV === 'staging' ||
    env.NODE_ENV === 'test' ||
    env.NODE_ENV === 'development'
  );
}

export type MockOauthDeps = {
  prisma: Pick<PrismaClient, 'user' | 'account'>;
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  /**
   * UUID factory injectable — par défaut `randomUUID` de node:crypto.
   * Utile pour les tests déterministes qui veulent assert un UUID précis.
   */
  generateUuid?: () => string;
};

/**
 * Factory du provider Credentials mocké. Reproduit ce que le PrismaAdapter
 * + OAuth provider Google/Microsoft auraient fait, sans appel réseau externe.
 *
 * **Ne PAS exporter directement** — passer par `buildMockOauthProvider()`
 * qui appelle `assertSafeContext()` d'abord.
 */
function buildProvider({ prisma, logger = console, generateUuid = randomUUID }: MockOauthDeps) {
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

      // Reproduit le comportement du PrismaAdapter OAuth + event createUser :
      // 1. Cherche un user par email (avec allowDangerousEmailAccountLinking
      //    actif côté Google/Microsoft, le link est automatique).
      // 2. Si absent, crée un user AVEC `supabaseUserId` UUID v4.
      // 3. Crée la row Account si elle n'existe pas (provider=<mockProvider>).
      //
      // ⚠️ BUG-2026-05-21 : Auth.js v5 NE déclenche PAS `events.createUser`
      // pour les providers Credentials (uniquement OAuth via PrismaAdapter).
      // Comme le mock est un Credentials provider, l'event câblé dans `auth.ts`
      // ne tourne JAMAIS sur ce flow → si on ne posait pas `supabaseUserId`
      // ici, tous les users mock auraient `supabaseUserId=NULL` et le
      // Dashboard crasherait via `userUuid()` (cf. `lib/auth/get-user.ts:76`).
      //
      // Donc on reproduit ici localement ce que `createCreateUserEvent` aurait
      // posé : `supabaseUserId = randomUUID()`. Idempotent (on ne touche pas
      // au user existant si trouvé par findUnique).
      let user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true },
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            email,
            emailVerified: mockEmailVerified === 'true' ? new Date() : null,
            // Pont vers tenants.user_id / subscriptions.user_id (UUID).
            // Sans ça → Dashboard 500 sur userUuid() pour ce user.
            supabaseUserId: generateUuid(),
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
