// Middleware Auth.js v5 (edge runtime), plus la CSP à nonce (VER-265).
//
// Utilise auth.config.ts (edge-safe, sans adapter Prisma) pour décider de
// l'autorisation via la callback `authorized()`. La logique des paths
// publics/protégés est centralisée dans auth.config.ts.
//
// NB : pas d'appel Prisma ici — Prisma n'est pas edge-compatible. Toute
// logique Node-only (PrismaAdapter, CredentialsProvider) vit dans auth.ts.
//
// ⚠️ Avec un handler, Auth.js v5 N'APPLIQUE PLUS la redirection d'un `authorized()` qui rend false (next-auth/lib/index.js,
// handleAuth : la branche du handler passe avant celle du refus). Le handler la rejoue donc lui-même, à l'identique ; un test la garde.

import NextAuth from 'next-auth';
import { NextResponse, type NextRequest } from 'next/server';

import { authConfig } from '@/auth.config';
import { enteteCsp, nonce, politique } from '@/lib/security/csp';

const { auth } = NextAuth(authConfig);

type RequeteAuth = NextRequest & { auth: Parameters<NonNullable<typeof authConfig.callbacks.authorized>>[0]['auth'] };

export async function avecCsp(req: RequeteAuth): Promise<Response> {
  const decision = await authConfig.callbacks.authorized({ auth: req.auth, request: req });
  if (decision instanceof Response) return decision;
  if (!decision) {
    const page = authConfig.pages?.signIn ?? '/api/auth/signin';
    if (req.nextUrl.pathname !== page) {
      const vers = req.nextUrl.clone();
      vers.pathname = page;
      vers.searchParams.set('callbackUrl', req.nextUrl.href);
      return NextResponse.redirect(vers);
    }
  }
  const n = nonce();
  const csp = politique(n);
  const nom = enteteCsp();
  // Next lit le nonce dans l'en-tête CSP de la requête (bloquant ou Report-Only) et l'appose à ses propres scripts.
  const h = new Headers(req.headers);
  h.set(nom.toLowerCase(), csp);
  h.set('x-nonce', n);
  const r = NextResponse.next({ request: { headers: h } });
  r.headers.set(nom, csp);
  return r;
}

export const middleware = auth(avecCsp as never);

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
     * - api/admin/emprunt, api/auth/emprunt, api/auth/impersonate-callback : elles REMPLACENT la session.
     *   Le middleware re-signe celle qui arrive et la reposerait par-dessus. Elles se gardent seules.
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - images - .svg, .png, .jpg, .jpeg, .gif, .webp
     */
    '/((?!api/pricing/plans|api/admin/emprunt|api/auth/emprunt|api/auth/impersonate-callback|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
