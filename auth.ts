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
        const credsAccount = user.accounts.find((a) => a.provider === 'credentials');
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
    async signIn({ user, account }) {
      // Hook 2FA : quand un user avec mfaEnabled=true se login via Google ou
      // Credentials, on génère un code et on redirige vers /auth/mfa.
      //
      // Auth.js n'a pas de "pre-session" natif, donc le pattern est :
      // 1. signIn callback retourne `/auth/mfa?userId=...` (un path = "allow
      //    with redirect" selon la doc Auth.js v5)
      // 2. Le handler POST /api/auth/mfa/verify crée la vraie session
      //
      // On déclenche l'envoi du mail côté serveur ici (pas dans le middleware).

      if (!user.email) {
        return false;
      }

      // Fetch le user Prisma pour vérifier mfaEnabled
      const dbUser = await prisma.user.findUnique({
        where: { email: user.email },
        select: { id: true, email: true, mfaEnabled: true },
      });

      if (!dbUser) {
        // Premier login Google / Credentials → le PrismaAdapter va créer le
        // user. On laisse passer (pas de 2FA au premier login).
        return true;
      }

      if (dbUser.mfaEnabled) {
        try {
          await issueAndSendMfaCode({ id: dbUser.id, email: dbUser.email });
        } catch (err) {
          console.error('[auth] failed to issue MFA code', err);
          return false;
        }
        // Rediriger vers /auth/mfa avec l'id du user encodé en cookie
        // temporaire (géré par le handler ci-dessous via Set-Cookie)
        return `/auth/mfa?uid=${encodeURIComponent(dbUser.id)}`;
      }

      return true;
    },
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
