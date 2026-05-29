/**
 * GET /api/me/lite — Session "lite" lisible cross-subdomain.
 *
 * Usage : la landing CF Pages sur veridian.site (apex) appelle cet endpoint
 * en début de page pour savoir si l'utilisateur a déjà une session active sur
 * app.veridian.site (cookie partagé `.veridian.site`). Permet d'afficher
 * "Bienvenue Robert" + bouton "Aller au dashboard" au lieu du One Tap.
 *
 * Forme du retour (toujours 200) :
 *   { authenticated: false }
 *   { authenticated: true, email, name?, image? }
 *
 * Volontairement **lite** :
 *   - PAS de userId (pas besoin côté landing, et éviter de leaker un ID
 *     interne qu'on pourrait corréler à autre chose).
 *   - PAS de workspaceId, role, plan — la landing ne pilote pas le SaaS.
 *   - PAS d'expiry — la landing refait un /api/me/lite à chaque visite.
 *
 * CORS : whitelist `lib/cors/landing-cors.ts`. Origin non whitelisté → la
 * réponse sort sans headers Allow-Origin (= rejet navigateur). Toujours 200
 * côté HTTP pour ne pas casser le fetch JS si l'origin n'est pas couverte
 * (le test reste : "la promesse fetch() a échoué côté browser").
 *
 * Rate-limit : 100 req/min/IP (cap large : la landing peut faire 1 call par
 * navigation, un humain qui surf peut hit ~30 routes en 1 min facile).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import {
  buildLandingCorsHeaders,
  landingCorsPreflightResponse,
} from '@/lib/cors/landing-cors';
import { RateLimiter, extractClientIp } from '@/lib/auth/rate-limit';
import {
  readSessionHintFromRequest,
  setSessionHintCookie,
} from '@/lib/auth/session-hint-cookie';

// Limiter dédié — instance module-level partagée entre tous les calls.
// 100/min/IP : généreux pour la landing (1 call/page) tout en étouffant un
// scraper qui tenterait d'inférer des emails (l'endpoint ne donne rien sans
// cookie, mais on cap quand même par défense en profondeur).
const meLiteLimiter = new RateLimiter({
  capacity: 100,
  windowMs: 60_000,
  name: 'me-lite',
});

export async function OPTIONS(request: NextRequest) {
  return landingCorsPreflightResponse(request, {
    methods: ['GET', 'OPTIONS'],
  });
}

export async function GET(request: NextRequest) {
  const corsHeaders = buildLandingCorsHeaders(request, { methods: ['GET', 'OPTIONS'] });

  // Rate-limit avant tout — un scraper qui spamme doit cap, peu importe l'auth.
  const ip = extractClientIp(request.headers);
  const rate = meLiteLimiter.enforceWithBypass(ip, request.headers);
  if (!rate.ok) {
    return NextResponse.json(
      { authenticated: false, error: 'rate_limited' },
      {
        status: 429,
        headers: {
          ...corsHeaders,
          'Retry-After': String(rate.retryAfterSeconds),
        },
      },
    );
  }

  // Fast path : si le cookie hint `veridian-session-hint` est présent et
  // valide (signature HS256 OK, exp non dépassée), on répond direct sans
  // toucher à Auth.js / Prisma. Bénéfices :
  //  - latence : pas de JWE decode + pas de session table lookup
  //  - résilience : marche même si Auth.js temporairement KO
  //  - cross-subdomain : le hint cookie a scope .veridian.site donc il
  //    arrive bien sur les requêtes cross-origin depuis la landing
  try {
    const hint = await readSessionHintFromRequest(request);
    if (hint) {
      return NextResponse.json(
        {
          authenticated: true,
          email: hint.email,
          name: hint.name ?? null,
          image: hint.image ?? null,
          source: 'hint',
        },
        { status: 200, headers: corsHeaders },
      );
    }
  } catch {
    // Lecture hint silencieuse — on retombe en fallback Auth.js.
  }

  // Fallback : session Auth.js standard (cookie session principal). Plus
  // coûteux mais authority de vérité. Si auth() retourne un user mais le
  // hint cookie n'existait pas, on en profite pour le poser au passage —
  // bootstrap idempotent pour les users existants qui n'ont pas encore
  // visité la landing depuis le déploiement de cette feature.
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { authenticated: false },
      { status: 200, headers: corsHeaders },
    );
  }

  const response = NextResponse.json(
    {
      authenticated: true,
      email: session.user.email,
      name: session.user.name ?? null,
      image: session.user.image ?? null,
      source: 'session',
    },
    { status: 200, headers: corsHeaders },
  );
  // Best-effort : pose le hint pour la prochaine visite. Échec silencieux
  // (SESSION_HINT_SECRET pas configuré → on ne casse pas /api/me/lite).
  try {
    await setSessionHintCookie(response, {
      email: session.user.email,
      name: session.user.name ?? null,
      image: session.user.image ?? null,
    });
  } catch {
    /* noop — hint best-effort */
  }
  return response;
}
