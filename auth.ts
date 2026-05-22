// Auth.js v5 — config complète (Node runtime).
// Inclut l'adapter Prisma + le CredentialsProvider legacy (email/password).
//
// NE PAS importer ce fichier depuis le middleware edge — utiliser auth.config.ts
// à la place.

import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { issueAndSendMfaCode } from '@/lib/mfa';
import { authConfig } from './auth.config';
import { createSignInCallback } from '@/lib/auth/sign-in-callback';
import { createCreateUserEvent } from '@/lib/auth/create-user-event';
import { buildMockOauthProvider } from '@/lib/auth/mock-oauth-provider';
import { createOauthEventLogger } from '@/lib/auth/oauth-event-log';

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

// Mock OAuth provider — fabriqué hors du tableau pour pouvoir filtrer null
// proprement (Auth.js v5 typage Provider n'accepte pas null inline). Renvoie
// null en prod, un provider Credentials en staging/test/dev avec le flag.
const mockOauthProvider = buildMockOauthProvider({ prisma });

// Logger d'audit OAuth (table hub_app.oauth_signin_events). Best-effort —
// n'altère jamais le flow OAuth. Câblé sur l'event `signIn` (succès) et
// l'override `logger.error` (échec). Cf. lib/auth/oauth-event-log.ts.
const oauthEventLogger = createOauthEventLogger({ prisma });

// Providers OAuth réels — sert à distinguer un event `signIn` OAuth d'un
// login Credentials (qu'on ne trace PAS dans oauth_signin_events).
const OAUTH_PROVIDER_IDS = new Set(['google', 'microsoft-entra-id', 'mock-oauth']);

// Codes d'erreur Auth.js qui signalent un échec de flow OAuth (à tracer).
// `Configuration` et `OAuthCallbackError` sont déjà tagués critical par le
// logger ci-dessous. `OAuthSignInError` / `OAuthAccountNotLinked` couvrent
// les échecs côté flow (provider injoignable, link refusé).
const OAUTH_FAILURE_ERROR_NAMES = new Set([
  'Configuration',
  'OAuthCallbackError',
  'OAuthSignInError',
  'OAuthAccountNotLinked',
  'AccessDenied',
]);

export const { auth, handlers, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  // Logger structuré (JSON sur stderr) pour les erreurs Auth.js.
  // Cible prioritaire : `Configuration` (provider mal câblé côté serveur) et
  // `OAuthCallbackError` (provider en panne ou réponse invalide) — ces 2 codes
  // signalent un incident infrastructure et doivent ressortir dans Grafana
  // Loki via le pipeline stderr. Les autres warnings restent en JSON pour
  // grep/structured queries. Le ticket monitoring OAuth (rate-limiting +
  // alerting Telegram) câblera l'alerting sur `[auth-error][critical]`.
  logger: {
    error(error) {
      const name = error?.name ?? 'UnknownAuthError';
      const message = error?.message ?? String(error);
      const critical = name === 'Configuration' || name === 'OAuthCallbackError';
      const tag = critical ? '[auth-error][critical]' : '[auth-error]';
      console.error(
        JSON.stringify({
          tag,
          level: 'error',
          name,
          message,
          cause: error?.cause ? String(error.cause) : undefined,
          stack: error?.stack,
          ts: new Date().toISOString(),
        })
      );

      // Audit : si l'erreur signale un échec de flow OAuth, on append une row
      // 'failure' dans oauth_signin_events. Best-effort — l'écriture swallow
      // ses propres erreurs. Pas d'IP/UA ici : le logger Auth.js ne reçoit
      // pas la request, seul le nom du code d'erreur est exploitable.
      if (OAUTH_FAILURE_ERROR_NAMES.has(name)) {
        void oauthEventLogger.recordOauthFailure({ errorCode: name });
      }
    },
    warn(code) {
      console.warn(JSON.stringify({ tag: '[auth-warn]', level: 'warn', code, ts: new Date().toISOString() }));
    },
    debug(message, metadata) {
      if (process.env.AUTH_DEBUG === 'true') {
        console.debug(JSON.stringify({ tag: '[auth-debug]', level: 'debug', message, metadata, ts: new Date().toISOString() }));
      }
    },
  },
  providers: [
    ...authConfig.providers,
    // Mock OAuth provider — actif uniquement quand OAUTH_TEST_PROVIDER=true
    // ET (DEPLOY_ENV=staging OU NODE_ENV=test/development). En prod, le
    // provider est `null` et exclu du tableau par le `.filter()` ci-dessous.
    // Cf. lib/auth/mock-oauth-provider.ts pour les 3 garde-fous.
    ...(mockOauthProvider ? [mockOauthProvider] : []),
    Credentials({
      name: 'Email',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) {
          return null;
        }

        const { email, password } = parsed.data;
        const user = await prisma.user.findUnique({
          where: { email },
          include: { accounts: true },
        });

        // Legacy bridge : si le user n'existe pas dans hub_app.users, on ne
        // tente PAS de re-fetch dans Supabase. Le flow CredentialsProvider ne
        // gère que les users déjà migrés vers Auth.js. Les autres passent par
        // l'ancien flow Supabase Auth (inchangé).
        if (!user) {
          return null;
        }

        // Trouver un account "credentials" avec password hash stocké dans
        // access_token (simple bridge, pas un vrai token OAuth).
        // Note : type inféré depuis user.accounts (include actif). En CI Prisma 7
        // le re-export de types peut être incomplet selon le résolveur, on utilise
        // une annotation type-safe minimale via typeof.
        type AccountLike = typeof user.accounts[number];
        const credsAccount = user.accounts.find((a: AccountLike) => a.provider === 'credentials');
        if (!credsAccount?.access_token) {
          return null;
        }

        const ok = await bcrypt.compare(password, credsAccount.access_token);
        if (!ok) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Callback signIn extrait dans lib/auth/sign-in-callback.ts pour le tester
    // unitairement. Gère MFA + retour boolean/string (path) selon spec Auth.js v5.
    signIn: createSignInCallback({ prisma, issueAndSendMfaCode }),
    async jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
      }
      // Les claims `impersonated` / `impersonatedBy` sont posés directement
      // dans le JWT par /api/auth/impersonate-callback (encode @auth/core).
      // Ils ne transitent jamais par l'objet `user` — on les laisse vivre
      // tels quels dans le token : ce `return token` les préserve au refresh.
      return token;
    },
    async session({ session, token }) {
      if (token?.uid && session.user) {
        session.user.id = token.uid as string;
      }
      // Expose le marqueur d'impersonation côté session pour que les Server
      // Components / routes admin puissent (a) afficher une bannière et
      // (b) refuser la ré-impersonation via isImpersonatedSession().
      if (token?.impersonated === true && session.user) {
        session.user.impersonated = true;
        session.user.impersonatedBy =
          typeof token.impersonatedBy === 'string' ? token.impersonatedBy : null;
      }
      return session;
    },
  },
  events: {
    // Patch les users fraîchement créés par le PrismaAdapter (= signup OAuth
    // Google / Microsoft) avec un `supabaseUserId` UUID v4. Sans ça, le flow
    // OAuth crée des users orphelins → Dashboard Layout en panne (cf.
    // régression 2026-05-21 : tramtechservices@gmail.com + augustindemaret).
    // Le flow Credentials génère déjà l'UUID lui-même dans signup/route.ts.
    createUser: createCreateUserEvent({ prisma }),

    // Audit : trace les logins OAuth réussis dans oauth_signin_events.
    // L'event `signIn` Auth.js v5 n'est appelé QUE sur succès — les échecs
    // passent par l'override `logger.error` ci-dessus. On filtre sur le
    // provider : un login Credentials ne doit PAS polluer la table OAuth.
    // Best-effort — `recordOauthSuccess` swallow ses propres erreurs.
    async signIn({ user, account }) {
      const providerId = account?.provider;
      if (providerId && OAUTH_PROVIDER_IDS.has(providerId)) {
        void oauthEventLogger.recordOauthSuccess({
          provider: providerId,
          email: user?.email ?? null,
        });
      }
    },
  },
});
