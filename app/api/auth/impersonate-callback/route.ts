/**
 * GET /api/auth/impersonate-callback?token=<rawToken>
 *
 * Consomme un token impersonate (généré par POST /api/auth/impersonate-set)
 * et pose le cookie de session Auth.js pour le user ciblé, puis redirige
 * vers /dashboard.
 *
 * C'est un endpoint GET volontairement : il est destiné à être OUVERT dans
 * le navigateur (clic sur le lien retourné à l'admin). La possession du
 * token court-vécu (32 bytes random, usage unique, TTL 10min) EST
 * l'autorisation — exactement le modèle d'un magic link. Aucune session
 * admin n'est requise ici : l'admin a déjà été authentifié à l'étape
 * impersonate-set, c'est là que l'audit `start` a été écrit.
 *
 * Sécurité (tier 🔴 HAUT) :
 *  - Token usage unique : `consumeImpersonationToken` fait un delete atomique.
 *    Un token rejoué → 410 Gone.
 *  - Token expiré → 410 Gone (et de toute façon supprimé).
 *  - La session posée est un JWT Auth.js marqué `impersonated: true` +
 *    `impersonatedBy` → TTL court (1h) + blocage de la ré-impersonation.
 *  - Audit log `admin.impersonate.consume` à chaque consommation réussie.
 *  - Le cookie est httpOnly + secure (selon l'URL) + sameSite=lax, comme un
 *    cookie de session Auth.js normal.
 */

import { NextRequest, NextResponse } from 'next/server';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { prisma } from '@/lib/prisma';
import {
  consumeImpersonationToken,
  encodeImpersonationSessionJwt,
  sessionCookieName,
  useSecureCookies,
  IMPERSONATION_SESSION_TTL_S,
} from '@/lib/auth/impersonation';
import { getURL } from '@/utils/helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Page d'erreur générique — renvoie vers /login avec un code lisible. */
function errorRedirect(code: string, status: number): NextResponse {
  const url = `${getURL('/login')}?error=${encodeURIComponent(code)}`;
  // Redirige (303 See Other) mais conserve un status sémantique dans le body
  // pour les appels programmatiques / tests.
  const res = NextResponse.redirect(url, 303);
  res.headers.set('x-impersonate-error', code);
  res.headers.set('x-impersonate-status', String(status));
  return res;
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return errorRedirect('impersonate_missing_token', 400);
  }

  // 1. Consomme le token — delete atomique (usage unique) + check expiry.
  const result = await consumeImpersonationToken(prisma, token);
  if (!result.ok) {
    // not_found = token inconnu OU déjà consommé ; expired = périmé.
    const code =
      result.reason === 'expired'
        ? 'impersonate_token_expired'
        : 'impersonate_token_invalid';
    console.warn(
      JSON.stringify({
        tag: '[impersonate-callback]',
        level: 'warn',
        reason: result.reason,
        ts: new Date().toISOString(),
      })
    );
    return errorRedirect(code, 410);
  }

  // 2. Résout le user cible (l'identifier du token est la source de vérité).
  const targetUser = await prisma.user.findUnique({
    where: { id: result.targetUserId },
    select: { id: true, email: true, name: true, image: true },
  });
  if (!targetUser) {
    // Token valide mais user supprimé entre-temps — cas rare.
    return errorRedirect('impersonate_user_gone', 404);
  }

  // 3. Encode un vrai JWT de session Auth.js, marqué `impersonated`.
  //    `impersonatedBy` est volontairement générique ici : l'identité de
  //    l'admin déclencheur a été tracée à l'étape `start` (audit log). On
  //    note "admin" pour la bannière UI sans relire l'audit.
  let sessionJwt: string;
  try {
    sessionJwt = await encodeImpersonationSessionJwt({
      user: {
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        image: targetUser.image,
      },
      impersonatedBy: 'admin',
    });
  } catch (err) {
    // AUTH_SECRET manquant → on ne pose AUCUN cookie. Refus net.
    console.error(
      JSON.stringify({
        tag: '[impersonate-callback]',
        level: 'error',
        message: 'failed to encode impersonation session',
        error: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      })
    );
    return errorRedirect('impersonate_session_error', 500);
  }

  // 4. Audit — l'impersonation a effectivement été consommée.
  await writeAuditLog(prisma, {
    action: 'admin.impersonate.consume',
    actor: 'token:IMPERSONATE',
    targetType: 'user',
    targetId: targetUser.id,
    payload: { targetEmail: targetUser.email },
  });

  // 5. Pose le cookie de session Auth.js + redirige vers le dashboard.
  const secure = useSecureCookies();
  const cookieName = sessionCookieName(secure);
  const res = NextResponse.redirect(getURL('/dashboard'), 303);
  res.cookies.set(cookieName, sessionJwt, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: IMPERSONATION_SESSION_TTL_S,
  });
  return res;
}
