/**
 * POST /api/auth/session-hint/refresh
 *
 * Pose / refresh le cookie hint `veridian-session-hint` pour l'utilisateur
 * actuellement authentifié. Appelé par le client (ex: hook React dans le
 * dashboard layout) après un login réussi pour exposer un indice JS-lisible
 * cross-subdomain à la landing CF Pages (veridian.site).
 *
 * Pourquoi une route séparée et pas un event Auth.js :
 *   Auth.js v5 `events.signIn` n'a pas accès au response object — impossible
 *   de poser un cookie depuis là. Soit on patche le PrismaAdapter (fragile,
 *   couplage fort), soit on délègue au client via cette route (transparent,
 *   idempotent, testable). On choisit la 2ème option.
 *
 * Auth required : `auth()` retourne null → 401 sans poser de cookie. Pas
 * de fuite d'info à un attaquant non loggué.
 *
 * Rate-limit : pas nécessaire ici (route auth-required, le client n'appelle
 * que sur login success + au démarrage du dashboard).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { setSessionHintCookie } from '@/lib/auth/session-hint-cookie';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  try {
    await setSessionHintCookie(response, {
      email: session.user.email,
      name: session.user.name ?? null,
      image: session.user.image ?? null,
    });
  } catch (err) {
    // SESSION_HINT_SECRET absent ou < 32 chars → on log et on échoue
    // proprement. Pas bloquant pour le user (la session principale reste
    // valide), mais le hint ne sera pas posé → la landing ne saura pas
    // qu'il est loggué.
    console.error(
      JSON.stringify({
        tag: '[session-hint-refresh]',
        level: 'error',
        message: 'failed to set hint cookie',
        reason: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json({ ok: false, error: 'misconfigured' }, { status: 500 });
  }
  return response;
}
