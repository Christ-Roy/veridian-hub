// Middleware Auth.js v5 (edge runtime).
//
// Utilise auth.config.ts (edge-safe, sans adapter Prisma) pour décider de
// l'autorisation via la callback `authorized()`. La logique des paths
// publics/protégés est centralisée dans auth.config.ts.
//
// NB : pas d'appel Prisma ici — Prisma n'est pas edge-compatible. Toute
// logique Node-only (PrismaAdapter, CredentialsProvider) vit dans auth.ts.

import NextAuth from 'next-auth';
import { authConfig } from '@/auth.config';

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - api/pricing/plans (PUBLIC, force-static + Cache-Control public — doit
     *   être cachable edge CDN. Auth.js middleware injecte des Set-Cookie
     *   CSRF qui invalident le cache edge (RFC 7234 §3). Cet endpoint est
     *   consommé en HTTP par Notifuse Go au boot, donc bénéficie 10× de la
     *   cache edge. Cf. todo/2026-05-21-fix-cache-cookies-pricing-plans.md.
     *   Sûr car la route n'a aucune logique auth (catalogue public statique).
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - images - .svg, .png, .jpg, .jpeg, .gif, .webp
     */
    '/((?!api/pricing/plans|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
