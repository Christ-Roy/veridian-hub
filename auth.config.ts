// Auth.js v5 — config EDGE-SAFE (sans adapter Prisma).
// Utilisée par le middleware qui tourne en edge runtime. Les callbacks ici ne
// peuvent PAS utiliser Prisma.
//
// La config "complète" (avec adapter Prisma + providers Node-only) vit dans
// ./auth.ts et reprend ce fichier en base.

import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';

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
      // Auto-link au user existant si l'email matche (= comportement standard
      // marché 2026 : Discord, Stripe, Vercel, Linear, Notion, Slack, Figma,
      // GitHub, etc.). Sûr car Google certifie `email_verified=true` dans
      // l'id_token OIDC — on fait confiance à Google pour la vérif d'email.
      // Sans ce flag, un user existant (créé via Credentials/magic link) qui
      // tente le bouton "Continuer avec Google" voit `OAuthAccountNotLinked`,
      // ce qui casse l'UX standard.
      //
      // Le nom "dangerous" du flag Auth.js v5 est historique et exagéré pour
      // les providers qui vérifient l'email ; cf. doc Auth.js qui le
      // recommande explicitement pour Google + Microsoft.
      allowDangerousEmailAccountLinking: true,
    }),
    // Multi-tenant (issuer par défaut common/v2.0/) — accepte comptes Microsoft
    // Work/School ET personnels (Outlook, Xbox, Skype). Cf. décision D4 du ticket
    // todo/2026-05-20-oauth-signin-google-microsoft-cross-app.md.
    //
    // Auto-link activé pour la même raison que Google : Microsoft Entra
    // certifie `xms_edov=true` (Email Domain Owner Verified) pour les comptes
    // dont l'email est sous un domaine vérifié côté tenant.
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
