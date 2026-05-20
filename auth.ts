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

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const { auth, handlers, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  providers: [
    ...authConfig.providers,
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
});
