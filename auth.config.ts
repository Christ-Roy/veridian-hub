// Auth.js v5 — config EDGE-SAFE (sans adapter Prisma).
// Utilisée par le middleware qui tourne en edge runtime. Les callbacks ici ne
// peuvent PAS utiliser Prisma.
//
// La config "complète" (avec adapter Prisma + providers Node-only) vit dans
// ./auth.ts et reprend ce fichier en base.

import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';

export const authConfig = {
  // Cookies session : 90 jours (3 mois)
  // Décision P1.4 : éviter que les tenants perdent leur compte facilement.
  // Le 2FA email opt-in compense pour la sécurité.
  session: {
    strategy: 'jwt',
    maxAge: 60 * 60 * 24 * 90, // 90 jours
    updateAge: 60 * 60 * 24, // 1 jour
  },
  pages: {
    signIn: '/login',
    verifyRequest: '/auth/mfa',
    error: '/login',
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      authorization: {
        params: {
          scope: 'openid email profile',
          prompt: 'select_account',
        },
      },
    }),
    // Le CredentialsProvider (email/password legacy) est branché uniquement
    // dans auth.ts (Node runtime) parce qu'il a besoin de Prisma + bcrypt.
  ],
  callbacks: {
    // Gate d'autorisation edge-safe — utilisé par le middleware Auth.js pour
    // décider si la requête passe. Pas de Prisma ici.
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;

      // Pages publiques Hub
      const publicPrefixes = [
        '/login',
        '/signin',
        '/signup',
        '/auth',
        '/api/auth',
        '/api/health',
        '/api/webhooks',
      ];

      if (publicPrefixes.some((p) => pathname.startsWith(p))) {
        return true;
      }

      // Marketing pages (hors (marketing) group)
      if (pathname === '/' || pathname.startsWith('/pricing') || pathname.startsWith('/legal')) {
        return true;
      }

      // Routes protégées : dashboard + admin → nécessitent une session
      if (pathname.startsWith('/dashboard') || pathname.startsWith('/admin')) {
        return !!auth;
      }

      return true;
    },
  },
} satisfies NextAuthConfig;
