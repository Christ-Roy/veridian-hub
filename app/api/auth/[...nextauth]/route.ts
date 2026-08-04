// Auth.js v5 catch-all route handler.
// Gère tous les endpoints /api/auth/* : signin, signout, callback, session, csrf...
//
// Note : coexiste avec les routes Supabase Auth legacy qui vivent ailleurs
// (app/(auth)/auth/callback, etc.). Auth.js ne touche qu'à /api/auth/*.
//
// Wrap des handlers Auth.js avec un rate-limiter IP-based : protège
// /api/auth/signin (start OAuth) et /api/auth/callback contre spam/bot.
// Les autres routes Auth.js (session, csrf, providers) ne sont PAS
// limitées (appelées légitimement plusieurs fois par page render).

import { handlers } from '@/auth';
import {
  oauthStartLimiter,
  oauthCallbackLimiter,
  credentialsLoginLimiter,
  extractClientIp,
} from '@/lib/auth/rate-limit';
import { buildClearedSessionHintSetCookie } from '@/lib/auth/session-hint-cookie';
import { NextRequest, NextResponse } from 'next/server';

function pickLimiter(pathname: string) {
  // Pathname typique : /api/auth/signin, /api/auth/signin/google,
  // /api/auth/callback, /api/auth/callback/microsoft-entra-id,
  // /api/auth/callback/credentials...
  //
  // Ordre important : /callback/credentials matche AVANT /callback générique
  // pour appliquer le limiter strict (5/min) anti-brute-force password.
  if (pathname.startsWith('/api/auth/callback/credentials')) {
    return credentialsLoginLimiter;
  }
  if (pathname.startsWith('/api/auth/signin')) return oauthStartLimiter;
  if (pathname.startsWith('/api/auth/callback')) return oauthCallbackLimiter;
  return null;
}

function makeTooManyResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      error: 'rate_limited',
      message: "Trop de tentatives. Patientez avant de réessayer.",
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
      },
    }
  );
}

async function withRateLimit(
  req: NextRequest,
  handler: (req: NextRequest) => Promise<Response>
): Promise<Response> {
  const url = new URL(req.url);
  const limiter = pickLimiter(url.pathname);
  if (!limiter) {
    return handler(req);
  }
  const ip = extractClientIp(req.headers);
  // enforceWithBypass : bypass E2E staging via header secret valide
  // (cf. RateLimiter.enforceWithBypass). En prod le bypass est ignoré
  // par `shouldBypassRateLimit` → comportement identique au legacy.
  const result = limiter.enforceWithBypass(ip, req.headers);
  if (!result.ok) {
    console.warn(
      JSON.stringify({
        tag: '[auth-ratelimit]',
        level: 'warn',
        path: url.pathname,
        ip,
        retry_after_s: result.retryAfterSeconds,
        ts: new Date().toISOString(),
      })
    );
    return makeTooManyResponse(result.retryAfterSeconds);
  }
  return handler(req);
}

// ─── Suppression du cookie hint au signOut ──────────────────────────────
//
// Auth.js ne connaît QUE son cookie de session : son signOut laisse vivre
// `veridian-session-hint` (scope .veridian.site, TTL 30j). Résultat sans ce
// patch : la landing veridian.site continue d'afficher "Mon compte" pendant
// un mois après une déconnexion, et le fast path /api/me/lite confirme ce
// mensonge.
//
// On intercepte donc le POST /api/auth/signout — le SEUL endpoint qui
// déconnecte réellement — et on ajoute le Set-Cookie de suppression du hint
// sur la réponse Auth.js, quelle qu'elle soit (302 vers callbackUrl, ou JSON
// quand le client passe `redirect: false`). Un Set-Cookie est honoré par le
// navigateur sur une 302 : la redirection ne l'annule pas.
//
// Pourquoi ici et pas dans `events.signOut` : l'event Auth.js v5 n'a aucun
// accès à l'objet réponse, il ne peut donc poser aucun cookie (c'est déjà la
// raison d'être de la route session-hint/refresh, cf. son en-tête). Le seul
// point d'accroche qui voit la réponse, c'est ce wrapper.
//
// Le GET /api/auth/signout n'est PAS visé : il sert la page de confirmation
// de déconnexion, aucune session n'est encore détruite à ce moment-là.
//
// Angle mort assumé : le `signOut()` serveur (importé depuis '@/auth' dans
// une server action) écrit ses cookies via next/headers sans passer par ce
// handler. Aucun code ne l'utilise aujourd'hui ; le jour où ça arrive, il
// faudra y ajouter un `clearSessionHintCookie` au même endroit.
function isSignOutPath(pathname: string): boolean {
  return pathname === '/api/auth/signout' || pathname.startsWith('/api/auth/signout/');
}

/**
 * Ajoute le Set-Cookie de suppression du hint sur une réponse Auth.js.
 *
 * Best-effort et non destructif : si les headers de la réponse sont
 * immuables (cas d'une réponse construite via `Response.redirect()`), on
 * reconstruit une réponse équivalente en réinjectant explicitement chaque
 * Set-Cookie existant — jamais de merge en une seule valeur virgulée, qui
 * corromprait les cookies de session posés par Auth.js.
 */
function appendHintClearCookie(response: Response): Response {
  let clearCookie: string;
  try {
    clearCookie = buildClearedSessionHintSetCookie();
  } catch {
    // Résolution du cookie impossible → on ne casse pas la déconnexion.
    return response;
  }

  try {
    response.headers.append('set-cookie', clearCookie);
    return response;
  } catch {
    // Headers immuables — on recompose.
  }

  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    headers.set(key, value);
  });
  for (const cookie of response.headers.getSetCookie()) {
    headers.append('set-cookie', cookie);
  }
  headers.append('set-cookie', clearCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const { GET: rawGET, POST: rawPOST } = handlers;

export async function GET(req: NextRequest) {
  return withRateLimit(req, rawGET);
}

export async function POST(req: NextRequest) {
  const response = await withRateLimit(req, rawPOST);
  if (isSignOutPath(new URL(req.url).pathname)) {
    return appendHintClearCookie(response);
  }
  return response;
}
