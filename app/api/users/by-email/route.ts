/**
 * GET /api/users/by-email?email=<urlencoded>
 *
 * Endpoint Discovery cross-app. Appelé par les apps downstream (Notifuse,
 * Prospection, Analytics, CMS) au login d'un user pour savoir si l'email
 * est déjà connu côté Hub et router vers ses apps actives.
 *
 * Spec ticket : `todo/2026-05-20-hub-discovery-by-email-pattern.md`
 *
 * Auth      : HMAC entrant — header `x-veridian-hub-signature` calculé
 *             avec le secret `<APP>_HUB_API_SECRET` (cf. CONTRAT-HUB §6.1 + §6.5).
 *             Cf. `lib/discovery/hmac.ts` pour la string canonique signée.
 * Rate      : 60/min/IP (pré-HMAC, anti-flood) + 30/min/app (post-HMAC,
 *             plafond par secret conformément au brief).
 * Query     : `email` (string email valide, max 254 chars).
 * Response  : `{ exists: boolean, tenants: [{ app, role }] }`
 *             Payload minimaliste par design (privacy) : pas de nom,
 *             pas d'autres emails, pas de workspace_id, pas de plan.
 *
 * Code de retour :
 *   - 200 : email trouvé ou non — toujours 200 si HMAC OK + query OK.
 *           (`exists: false` pour les inconnus, pas 404 — un 404 leak
 *           l'absence d'un compte sur un attaquant qui aurait quand
 *           même réussi à signer avec un secret HMAC valide ; on reste
 *           uniforme pour ne pas créer de timing/code-side-channel.)
 *   - 400 : query absente ou malformée
 *   - 401 : HMAC invalide (signature, timestamp, drift)
 *   - 429 : rate-limit dépassé (IP ou app)
 *   - 503 : secret côté Hub pas configuré
 *
 * No cache : `Cache-Control: no-store` + `dynamic: 'force-dynamic'`. La
 * réponse contient des données utilisateur, le cache CDN/intermédiaire
 * est strictement interdit.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import {
  discoveryAppLimiter,
  discoveryPreVerifyLimiter,
  extractClientIp,
} from '@/lib/auth/rate-limit';
import { verifyDiscoveryHmac } from '@/lib/discovery/hmac';
import { discoverAppsByEmail } from '@/lib/discovery/aggregate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  email: z.string().email().max(254),
});

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: NextRequest) {
  // 1) Pré-HMAC rate-limit (par IP) — freine un bot qui spam avant qu'on
  //    engage le coût CPU du HMAC + lookup DB.
  //    enforceWithBypass : bypass E2E staging via header secret valide
  //    (cf. lib/auth/rate-limit.ts). En prod le bypass est ignoré.
  const ip = extractClientIp(request.headers);
  const preRate = discoveryPreVerifyLimiter.enforceWithBypass(
    ip,
    request.headers,
  );
  if (!preRate.ok) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: {
          'Retry-After': String(preRate.retryAfterSeconds),
          ...NO_STORE_HEADERS,
        },
      },
    );
  }

  // 2) HMAC sur la requête GET (signature couvre method + path + query
  //    triée + timestamp). Pas de body sur GET.
  const url = new URL(request.url);
  const hmac = verifyDiscoveryHmac(request.headers, request.method, url);
  if (!hmac.ok) {
    return NextResponse.json(
      { error: 'unauthorized', reason: hmac.reason },
      { status: hmac.status, headers: NO_STORE_HEADERS },
    );
  }

  // 3) Plafond contractuel par secret : 30/min/app (clé = nom app HMAC-
  //    vérifié). Si une app A est compromise et abuse, A est plafonnée
  //    sans pénaliser les autres apps.
  //    enforceWithBypass aussi sur le post-HMAC pour la cohérence E2E —
  //    un client E2E qui pose le header bypass doit traverser les 2 couches.
  const appRate = discoveryAppLimiter.enforceWithBypass(
    hmac.app,
    request.headers,
  );
  if (!appRate.ok) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: {
          'Retry-After': String(appRate.retryAfterSeconds),
          ...NO_STORE_HEADERS,
        },
      },
    );
  }

  // 4) Validation query Zod — bloque les emails malformés, trop longs,
  //    ou paramètres parasites (Zod ignore les keys inconnues par défaut).
  const parsed = querySchema.safeParse({
    email: url.searchParams.get('email') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_query', issues: parsed.error.issues },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  // 5) Agrégation Hub : lookup user + tenants + memberships.
  try {
    const result = await discoverAppsByEmail(prisma, parsed.data.email);
    return NextResponse.json(result, {
      status: 200,
      headers: NO_STORE_HEADERS,
    });
  } catch (err) {
    // Log structuré côté observabilité, mais on ne leak pas le détail au
    // caller (un 500 générique suffit, le caller a 0 levier dessus).
    console.error(
      JSON.stringify({
        tag: '[discovery][by-email][error]',
        level: 'error',
        app: hmac.app,
        error: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
