// Auth.js v5 — config EDGE-SAFE (sans adapter Prisma).
// Utilisée par le middleware qui tourne en edge runtime. Les callbacks ici ne
// peuvent PAS utiliser Prisma.
//
// La config "complète" (avec adapter Prisma + providers Node-only) vit dans
// ./auth.ts et reprend ce fichier en base.

import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';

import { isDevHarnessEnabled } from '@/lib/dev/harness-guard';

export const authConfig = {
  // Session glissante d'un an, comme Gmail (demande de Robert, 07/11/2026) : l'usage la renouvelle
  // chaque jour, un an d'inactivité déconnecte. La contrepartie vit dans `auth.ts` (révocation lue
  // en base à chaque lecture) et dans `lib/auth/recent-auth.ts` (preuve récente pour les actions
  // sensibles). Changer `AUTH_SECRET` coupe toutes les sessions : c'est le bouton d'urgence.
  session: {
    strategy: 'jwt',
    maxAge: 60 * 60 * 24 * 365, // 1 an
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
      // Liaison à un compte existant : AUTORISÉE par Auth.js (flag ci-dessous), mais
      // la garde est dans `lib/auth/sign-in-callback.ts` (D1). Un compte existant n'est
      // rattaché à Google que si Google certifie `email_verified=true`, ou si la
      // ligne `account` existe déjà. Sinon la connexion est refusée (page
      // /auth/liaison-refusee). Sans ce flag, Auth.js refuse toute liaison, même
      // prouvée. Le nom « dangerous » est historique : la sécurité vient de la garde.
      allowDangerousEmailAccountLinking: true,
    }),
    // Multi-tenant (issuer par défaut common/v2.0/) — accepte comptes Microsoft
    // Work/School ET personnels (Outlook, Xbox, Skype). Cf. décision D4 du ticket
    // todo/2026-05-20-oauth-signin-google-microsoft-cross-app.md.
    //
    // Liaison : même garde que Google (D1). Seule preuve acceptée : `xms_edov=true`
    // (Email Domain Owner Verified), revendication optionnelle à activer dans
    // l'application Entra. `email` seul ne prouve rien (un tenant peut poser
    // n'importe quelle adresse). Les comptes Microsoft personnels n'ont pas
    // `xms_edov` : ils ne se lient donc jamais à un compte existant.
    MicrosoftEntraID({
      clientId: process.env.MICROSOFT_OAUTH_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_OAUTH_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
    // Le CredentialsProvider (email/password legacy) est branché uniquement
    // dans auth.ts (Node runtime) parce qu'il a besoin de Prisma + bcrypt.
  ],
  callbacks: {
    // Gate d'autorisation edge-safe — utilisé par le middleware Auth.js pour
    // décider si la requête passe. Pas de Prisma ici.
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;

      // ── Ateliers UI (`/dev/**`) ────────────────────────────────────────
      // Troisième et dernier verrou de l'atelier, celui qui tient même si
      // les deux autres sautent (cf. `lib/dev/harness-guard.ts`). Le
      // middleware est compilé dans TOUS les builds : un `page.tsx` créé par
      // mégarde sous `app/dev/` ne peut pas être servi en production, même
      // sans layout de segment. Sans ce test, `/dev/*` tombait sur le
      // `return true` final — donc public, sans session.
      //
      // `isDevHarnessEnabled()` ne lit que `process.env` (aucun Prisma,
      // aucun Node builtin) : il est edge-safe, on peut l'appeler ici.
      if (pathname === '/dev' || pathname.startsWith('/dev/')) {
        return isDevHarnessEnabled();
      }

      // Pages publiques Hub
      const publicPrefixes = [
        '/login',
        '/signin',
        '/signup',
        '/auth',
        '/onboard',
        '/api/onboarding',
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

      // Routes protégées : dashboard + admin → nécessitent une session.
      //
      // On teste `auth?.user`, PAS `!!auth` (GHSA-8fpg-xm3f-6cx3, critical).
      // Quand la config Auth.js produit une erreur côté serveur, l'objet
      // exposé par `auth()` n'est pas `null` : il est peuplé avec un objet
      // d'erreur. Un `!!auth` passe donc à `true` et le garde-fou s'ouvre
      // au lieu de se fermer — exactement le mauvais sens pour un fail.
      // `auth?.user` n'est renseigné que sur une vraie session.
      if (pathname.startsWith('/dashboard') || pathname.startsWith('/admin')) {
        return !!auth?.user;
      }

      return true;
    },
  },
} satisfies NextAuthConfig;
