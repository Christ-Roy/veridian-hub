/**
 * Provider Google One Tap pour Auth.js v5.
 *
 * **POURQUOI un provider Credentials et pas le provider Google natif** :
 *   Le flow OAuth classique `Google({...})` part d'un redirect navigateur
 *   vers `accounts.google.com` puis revient avec un `code` qu'Auth.js échange
 *   serveur-side. Google One Tap, lui, NE redirige PAS : le widget GSI
 *   (`accounts.google.com/gsi/client`) affiche une popup in-page et renvoie
 *   directement un `id_token` (JWT signé par Google) au callback JS.
 *
 *   Auth.js v5 beta.30 n'expose pas d'option `oneTap` sur le provider Google
 *   (la doc du ticket parle d'un support natif qui n'est pas présent dans
 *   cette version). On reçoit donc le credential côté client et on doit le
 *   valider nous-mêmes serveur-side.
 *
 *   On le fait via un provider Credentials dédié (`id: 'google-one-tap'`)
 *   plutôt qu'un endpoint maison qui forgerait un cookie de session : passer
 *   par Auth.js garantit que **tout le câblage existant tourne** — callback
 *   `signIn` (donc le **hook MFA email**, cf. sign-in-callback.ts), event
 *   `signIn` (audit `oauth_signin_events`), génération JWT/session. One Tap
 *   ne court-circuite donc PAS le 2FA : un user MFA-enabled qui clique la
 *   popup est redirigé vers `/auth/mfa` exactement comme via le bouton OAuth.
 *
 * **CE QUE CE PROVIDER FAIT** (dans `authorize()`) :
 *   1. Valide le `id_token` Google : signature (JWKS Google), `iss`, `aud`
 *      (= notre client_id), expiration. `jwtVerify` couvre signature + exp +
 *      iss ; on vérifie `aud` et `email_verified` explicitement.
 *   2. Retrouve le user par email, ou le crée.
 *   3. **Reproduit `events.createUser`** (patch `supabaseUserId` UUID v4 +
 *      provisioning workspace) : Auth.js v5 NE déclenche PAS `createUser`
 *      pour les providers Credentials (uniquement OAuth via PrismaAdapter).
 *      Sans ça, un user One Tap fraîchement créé aurait `supabaseUserId=NULL`
 *      → Dashboard 500 sur `userUuid()`. Même piège que mock-oauth-provider.
 *   4. Crée la row `Account` (provider=`google`) si absente — cohérent avec
 *      ce que le bouton OAuth Google aurait produit (account linking).
 *
 * **GARDE-FOU ENV** : le provider n'est branché que hors staging — cohérent
 *   avec `allowOauth` (utils/auth-helpers/settings.ts). Staging est derrière
 *   Tailscale et ne déclare pas de redirect URI / origin chez Google.
 */

import { randomUUID } from 'node:crypto';
import Credentials from 'next-auth/providers/credentials';
import {
  createRemoteJWKSet,
  jwtVerify,
  type CryptoKey,
  type JWTPayload,
  type JWTVerifyGetKey,
  type KeyObject,
} from 'jose';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { provisionDefaultWorkspace } from '@/lib/workspace/provision';

/** Issuers acceptés pour un id_token Google OIDC. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Endpoint JWKS Google — clés publiques de signature des id_token. */
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

/**
 * JWKS Google — `createRemoteJWKSet` met en cache les clés et les rafraîchit
 * automatiquement (rotation Google). Singleton module-level : une seule
 * instance partagée entre tous les `authorize()`.
 */
const googleJwks = createRemoteJWKSet(GOOGLE_JWKS_URL);

const ONE_TAP_INPUT_SCHEMA = z.object({
  /** `id_token` JWT renvoyé par le widget GSI (champ `credential`). */
  credential: z.string().min(1),
});

/**
 * Shape attendue du payload d'un id_token Google après validation.
 * Google garantit `sub` + `email` + `email_verified` sur le scope `openid
 * email profile`.
 */
type GoogleIdTokenClaims = JWTPayload & {
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
};

/** `email_verified` peut arriver en bool ou string selon le flow Google. */
function isEmailVerified(claim: boolean | string | undefined): boolean {
  return claim === true || claim === 'true';
}

/**
 * Résout le client_id OAuth Google à utiliser comme `audience`. Le widget
 * One Tap signe le token pour ce client_id — il DOIT matcher.
 */
export function resolveGoogleClientId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GOOGLE_OAUTH_CLIENT_ID || undefined;
}

/**
 * Indique si le provider One Tap doit être branché.
 *
 * Règle alignée sur `allowOauth` (settings.ts) : actif partout SAUF staging
 * (Tailscale-only, pas d'origin déclaré chez Google). Requiert aussi un
 * client_id configuré — sans lui, `jwtVerify` ne pourrait pas valider l'aud.
 */
export function isGoogleOneTapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DEPLOY_ENV === 'staging') return false;
  return !!resolveGoogleClientId(env);
}

export type GoogleOneTapDeps = {
  /** Prisma client (mockable). `account` + `user` requis ; `PrismaClient`
   *  complet exigé par `provisionDefaultWorkspace`. */
  prisma: PrismaClient;
  /** Logger (mockable) — par défaut console. */
  logger?: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  /** UUID factory injectable pour les tests déterministes. */
  generateUuid?: () => string;
  /**
   * Vérificateur de token injectable. Par défaut `verifyGoogleIdToken`
   * (jose + JWKS Google). Les tests injectent un stub pour éviter le réseau.
   */
  verifyToken?: (credential: string, clientId: string) => Promise<GoogleIdTokenClaims>;
  /** Provision workspace (mockable) — par défaut le module workspace. */
  provisionWorkspace?: typeof provisionDefaultWorkspace;
};

/**
 * Valide un `id_token` Google contre les JWKS Google.
 *
 * Vérifie : signature (clés Google), `exp`/`nbf` (jose), `iss` (jose via
 * l'option `issuer`), `aud` (jose via `audience`). En complément on rejette
 * un email non vérifié — Google peut émettre un token pour un compte dont
 * l'email n'est pas confirmé, on refuse de créer/lier un compte dans ce cas.
 *
 * Throw une `Error` si le token est invalide pour quelque raison que ce soit.
 *
 * `keySet` est injectable uniquement pour les tests (clé locale, pas de
 * réseau) — en prod c'est toujours le JWKS Google distant.
 */
export async function verifyGoogleIdToken(
  credential: string,
  clientId: string,
  keySet: JWTVerifyGetKey | CryptoKey | KeyObject | Uint8Array = googleJwks,
): Promise<GoogleIdTokenClaims> {
  const options = { issuer: GOOGLE_ISSUERS, audience: clientId };
  // `jwtVerify` a deux overloads — clé statique (tests : clé locale) vs
  // getKey function (prod : JWKS Google distant). On branche explicitement
  // pour que TypeScript résolve le bon overload.
  const { payload } =
    typeof keySet === 'function'
      ? await jwtVerify(credential, keySet, options)
      : await jwtVerify(credential, keySet, options);
  const claims = payload as GoogleIdTokenClaims;

  if (!claims.email) {
    throw new Error('google-one-tap: id_token sans email');
  }
  if (!isEmailVerified(claims.email_verified)) {
    throw new Error('google-one-tap: email non vérifié par Google');
  }
  return claims;
}

/**
 * Construit le provider Credentials `google-one-tap`.
 *
 * **Ne pas exporter directement** — passer par `buildGoogleOneTapProvider()`
 * qui gère le garde-fou env (`isGoogleOneTapEnabled`).
 */
function buildProvider({
  prisma,
  logger = console,
  generateUuid = randomUUID,
  verifyToken,
  provisionWorkspace = provisionDefaultWorkspace,
}: GoogleOneTapDeps) {
  return Credentials({
    id: 'google-one-tap',
    name: 'Google One Tap',
    credentials: {
      credential: { label: 'Google ID token', type: 'text' },
    },
    async authorize(rawCredentials) {
      // Re-check du garde-fou env au call site — défense en profondeur.
      if (!isGoogleOneTapEnabled()) {
        logger.warn('[google-one-tap] authorize() appelé mais env non autorisé — refus');
        return null;
      }

      const clientId = resolveGoogleClientId();
      if (!clientId) {
        logger.error('[google-one-tap] GOOGLE_OAUTH_CLIENT_ID absent — refus');
        return null;
      }

      const parsed = ONE_TAP_INPUT_SCHEMA.safeParse(rawCredentials);
      if (!parsed.success) {
        return null;
      }

      // ─── 1. Validation cryptographique du id_token ─────────────────────
      let claims: GoogleIdTokenClaims;
      try {
        const verify = verifyToken ?? verifyGoogleIdToken;
        claims = await verify(parsed.data.credential, clientId);
      } catch (err) {
        // Token invalide / expiré / aud mismatch / email non vérifié.
        // On ne log pas le token lui-même (PII + secret de session courte).
        logger.warn(
          JSON.stringify({
            tag: '[google-one-tap]',
            level: 'warn',
            message: 'id_token rejeté',
            reason: err instanceof Error ? err.message : String(err),
            ts: new Date().toISOString(),
          }),
        );
        return null;
      }

      // `email` est garanti présent par verifyGoogleIdToken (sinon throw).
      const email = claims.email as string;
      const name = typeof claims.name === 'string' ? claims.name : null;
      const image = typeof claims.picture === 'string' ? claims.picture : null;

      // ─── 2. Retrouve ou crée le user ───────────────────────────────────
      // allowDangerousEmailAccountLinking est actif côté provider Google :
      // on s'aligne sur le même comportement (link par email vérifié).
      let user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, name: true, image: true, supabaseUserId: true },
      });

      let freshlyCreated = false;
      if (!user) {
        // ⚠️ Auth.js v5 NE déclenche PAS `events.createUser` pour les
        // providers Credentials. On reproduit ici ce que
        // `createCreateUserEvent` aurait posé : `supabaseUserId` UUID v4
        // (pont vers tenants.user_id / subscriptions.user_id) — sans lui le
        // Dashboard crashe sur `userUuid()`. Cf. mock-oauth-provider.ts.
        user = await prisma.user.create({
          data: {
            email,
            name,
            image,
            // Google certifie email_verified=true (déjà vérifié en étape 1).
            emailVerified: new Date(),
            supabaseUserId: generateUuid(),
          },
          select: { id: true, email: true, name: true, image: true, supabaseUserId: true },
        });
        freshlyCreated = true;
      } else if (!user.supabaseUserId) {
        // User existant sans pont UUID (legacy / créé hors flow standard) :
        // on backfill pour ne pas casser le Dashboard.
        await prisma.user.update({
          where: { id: user.id },
          data: { supabaseUserId: generateUuid() },
        });
      }

      // ─── 3. Crée la row Account (provider=google) si absente ───────────
      // `sub` Google = providerAccountId stable. Cohérent avec ce que le
      // PrismaAdapter aurait créé via le bouton OAuth Google.
      const providerAccountId = typeof claims.sub === 'string' ? claims.sub : email;
      const existingAccount = await prisma.account.findUnique({
        where: {
          provider_providerAccountId: {
            provider: 'google',
            providerAccountId,
          },
        },
        select: { id: true },
      });
      if (!existingAccount) {
        await prisma.account.create({
          data: {
            userId: user.id,
            type: 'oidc',
            provider: 'google',
            providerAccountId,
          },
        });
      }

      // ─── 4. Provisioning workspace pour un user fraîchement créé ───────
      // `events.createUser` s'en charge pour les signups OAuth classiques ;
      // ici on le fait nous-mêmes (best-effort, idempotent). Un échec ne
      // doit JAMAIS bloquer la session.
      if (freshlyCreated) {
        try {
          await provisionWorkspace(
            { userId: user.id, email: user.email, name: user.name ?? null },
            { prisma, actor: 'system:google-one-tap', logger },
          );
        } catch (err) {
          logger.error('[google-one-tap] échec provisioning workspace', err);
        }
      }

      logger.info?.(
        JSON.stringify({
          tag: '[google-one-tap]',
          level: 'info',
          message: freshlyCreated ? 'signup One Tap' : 'login One Tap',
          email,
          userId: user.id,
          ts: new Date().toISOString(),
        }),
      );

      // Auth.js déroule ensuite le callback `signIn` (hook MFA) puis émet la
      // session JWT — exactement comme un login OAuth classique.
      return { id: user.id, email: user.email, name: user.name, image: user.image };
    },
  });
}

/**
 * Fabrique le provider One Tap.
 *
 * Renvoie `null` si l'env n'autorise pas One Tap (staging, ou client_id
 * absent) — l'appelant (auth.ts) filtre les `null` du tableau de providers.
 */
export function buildGoogleOneTapProvider(deps: GoogleOneTapDeps) {
  if (!isGoogleOneTapEnabled()) return null;
  return buildProvider(deps);
}
