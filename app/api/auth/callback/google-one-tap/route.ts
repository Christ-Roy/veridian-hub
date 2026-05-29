/**
 * POST /api/auth/callback/google-one-tap
 *
 * Endpoint **cross-subdomain CORS-enabled** appelé par la landing
 * (veridian.site) avec le `id_token` JWT renvoyé par le widget Google
 * One Tap. Valide le token, retrouve/crée le user, forge un cookie session
 * Auth.js, et renvoie un JSON `{ ok, redirect }` (PAS de 302 — c'est le JS
 * landing qui redirige après lecture).
 *
 * Pourquoi une route custom et pas le provider Credentials Auth.js
 * (`/api/auth/callback/credentials`) :
 *   - Le callback Credentials Auth.js attend du `application/x-www-form-urlencoded`
 *     et renvoie une **redirect HTML** ; depuis un `fetch()` cross-origin
 *     avec `credentials: include`, ces deux choses cassent l'UX (la
 *     popup One Tap est déjà fermée quand on reçoit le credential, on
 *     veut juste poser un cookie et que la landing décide quoi faire).
 *   - On veut un contrat JSON propre et CORS-aware — beaucoup plus simple
 *     à câbler côté landing CF Pages.
 *   - On REUTILISE la validation cryptographique
 *     (`verifyGoogleIdToken`) et la logique de création user (bootstrap
 *     `supabaseUserId`, row `Account`, provisioning workspace) déjà
 *     éprouvée dans `lib/auth/google-one-tap-provider.ts`.
 *
 * Sécurité (tier 🟡 MOYEN) :
 *   - JWT validé contre les JWKS Google (signature, exp, iss, aud=client_id,
 *     email_verified=true).
 *   - Rate-limit 30/min/IP via `oauthCallbackLimiter` existant — un humain
 *     ne déclenche One Tap qu'une fois par session.
 *   - CORS strict : seules les origins whitelistées (veridian.site, etc.)
 *     reçoivent `Access-Control-Allow-Origin`. Origin inconnue → la réponse
 *     sort sans header CORS, le browser bloque côté landing.
 *   - Cookie session avec le scope `.veridian.site` (resolveSessionCookieConfig)
 *     — donc visible AUSSI depuis la landing au prochain /api/me/lite.
 *
 * Désactivé en staging (Tailscale-only, pas d'origin Google déclaré) :
 *   le provider One Tap n'est pas branché côté Auth.js (cf. settings.ts) →
 *   par cohérence on rejette aussi cette route. La condition est portée par
 *   `isGoogleOneTapEnabled()` qui lit DEPLOY_ENV.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import {
  verifyGoogleIdToken,
  resolveGoogleClientId,
  isGoogleOneTapEnabled,
} from '@/lib/auth/google-one-tap-provider';
import { provisionDefaultWorkspace } from '@/lib/workspace/provision';
import {
  buildLandingCorsHeaders,
  landingCorsPreflightResponse,
} from '@/lib/cors/landing-cors';
import {
  resolveSessionCookieName,
  setSessionCookieOnResponse,
} from '@/lib/auth/cookie-scope';
import { setSessionHintCookie } from '@/lib/auth/session-hint-cookie';
import { extractClientIp, oauthCallbackLimiter } from '@/lib/auth/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ONE_TAP_BODY_SCHEMA = z.object({
  credential: z.string().min(1).max(8192),
});

/** TTL session forgée par One Tap — aligné sur auth.config.ts (90 jours). */
const ONE_TAP_SESSION_TTL_S = 60 * 60 * 24 * 90;

export async function OPTIONS(request: NextRequest) {
  return landingCorsPreflightResponse(request, {
    methods: ['POST', 'OPTIONS'],
  });
}

export async function POST(request: NextRequest) {
  const corsHeaders = buildLandingCorsHeaders(request, {
    methods: ['POST', 'OPTIONS'],
  });

  // ─── Garde-fou env (cohérent avec le provider) ─────────────────────────
  if (!isGoogleOneTapEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'disabled' },
      { status: 503, headers: corsHeaders },
    );
  }

  // ─── Rate-limit (anti-flood) ───────────────────────────────────────────
  const ip = extractClientIp(request.headers);
  const rate = oauthCallbackLimiter.enforceWithBypass(ip, request.headers);
  if (!rate.ok) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited' },
      {
        status: 429,
        headers: { ...corsHeaders, 'Retry-After': String(rate.retryAfterSeconds) },
      },
    );
  }

  // ─── Parse body ─────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_body' },
      { status: 400, headers: corsHeaders },
    );
  }
  const parsed = ONE_TAP_BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'invalid_body' },
      { status: 400, headers: corsHeaders },
    );
  }

  const clientId = resolveGoogleClientId();
  if (!clientId) {
    // Garde-fou déjà couvert par isGoogleOneTapEnabled() mais on re-vérifie
    // ici parce que verifyGoogleIdToken throw sans audience.
    return NextResponse.json(
      { ok: false, error: 'misconfigured' },
      { status: 500, headers: corsHeaders },
    );
  }

  // ─── Validation cryptographique du id_token ────────────────────────────
  let claims;
  try {
    claims = await verifyGoogleIdToken(parsed.data.credential, clientId);
  } catch (err) {
    console.warn(
      JSON.stringify({
        tag: '[one-tap-callback]',
        level: 'warn',
        message: 'id_token rejeté',
        reason: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      { ok: false, error: 'invalid_token' },
      { status: 401, headers: corsHeaders },
    );
  }

  const email = claims.email as string;
  const name = typeof claims.name === 'string' ? claims.name : null;
  const image = typeof claims.picture === 'string' ? claims.picture : null;
  const providerAccountId = typeof claims.sub === 'string' ? claims.sub : email;

  // ─── Bootstrap user (réutilise le pattern provider) ────────────────────
  let user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, image: true, supabaseUserId: true },
  });

  let freshlyCreated = false;
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name,
        image,
        emailVerified: new Date(),
        supabaseUserId: randomUUID(),
      },
      select: { id: true, email: true, name: true, image: true, supabaseUserId: true },
    });
    freshlyCreated = true;
  } else if (!user.supabaseUserId) {
    await prisma.user.update({
      where: { id: user.id },
      data: { supabaseUserId: randomUUID() },
    });
  }

  const existingAccount = await prisma.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: 'google',
        providerAccountId,
      },
    },
    select: { id: true },
  });
  if (!existingAccount) {
    await prisma.account.create({
      data: {
        userId: user.id,
        type: 'oidc',
        provider: 'google',
        providerAccountId,
      },
    });
  }

  if (freshlyCreated) {
    try {
      await provisionDefaultWorkspace(
        { userId: user.id, email: user.email, name: user.name ?? null },
        { prisma, actor: 'system:google-one-tap-callback' },
      );
    } catch (err) {
      console.error('[one-tap-callback] échec provisioning workspace', err);
    }
  }

  // ─── Forge session JWT Auth.js + pose cookie cross-subdomain ───────────
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    console.error(
      JSON.stringify({
        tag: '[one-tap-callback]',
        level: 'error',
        message: 'AUTH_SECRET absent — impossible de forger la session',
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      { ok: false, error: 'misconfigured' },
      { status: 500, headers: corsHeaders },
    );
  }

  // Le salt DOIT être le nom du cookie — sinon @auth/core ne pourra pas
  // déchiffrer le JWT au prochain `auth()`. On lit le nom via le helper
  // unifié pour rester cohérent avec auth.ts.
  const cookieName = resolveSessionCookieName();
  const sessionJwt = await encode({
    salt: cookieName,
    secret,
    maxAge: ONE_TAP_SESSION_TTL_S,
    token: {
      uid: user.id,
      sub: user.id,
      email: user.email,
      name: user.name ?? null,
      picture: user.image ?? null,
    },
  });

  const response = NextResponse.json(
    {
      ok: true,
      redirect: '/dashboard',
      authenticated: true,
      email: user.email,
      name: user.name ?? null,
      image: user.image ?? null,
      freshlyCreated,
    },
    { status: 200, headers: corsHeaders },
  );
  setSessionCookieOnResponse(response, sessionJwt, { maxAge: ONE_TAP_SESSION_TTL_S });

  // Pose en parallèle le cookie hint cross-subdomain — c'est ce qui permet
  // à la landing veridian.site de détecter la session sans round-trip API.
  // Best-effort : si SESSION_HINT_SECRET n'est pas configuré, on ne casse
  // pas le flow One Tap (la session principale reste valide).
  try {
    await setSessionHintCookie(response, {
      email: user.email,
      name: user.name ?? null,
      image: user.image ?? null,
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        tag: '[one-tap-callback]',
        level: 'warn',
        message: 'failed to set session hint cookie (non-blocking)',
        reason: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
  }

  console.info(
    JSON.stringify({
      tag: '[one-tap-callback]',
      level: 'info',
      message: freshlyCreated ? 'signup One Tap (cross-subdomain)' : 'login One Tap (cross-subdomain)',
      email,
      userId: user.id,
      ts: new Date().toISOString(),
    }),
  );

  return response;
}
