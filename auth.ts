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

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

// Mock OAuth provider — fabriqué hors du tableau pour pouvoir filtrer null
// proprement (Auth.js v5 typage Provider n'accepte pas null inline). Renvoie
// null en prod, un provider Credentials en staging/test/dev avec le flag.
const mockOauthProvider = buildMockOauthProvider({ prisma });

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
      return token;
    },
    async session({ session, token }) {
      if (token?.uid && session.user) {
        session.user.id = token.uid as string;
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
  },
});
