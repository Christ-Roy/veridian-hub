/** Point de jetons : code + PKCE, ou renouvellement à rotation. */
import { NextResponse, type NextRequest } from 'next/server';

import { extractClientIp, mcpTokenLimiter } from '@/lib/auth/rate-limit';
import { CORS } from '@/lib/mcp/config';
import { lireParams, preflight, reponseErreur } from '@/lib/mcp/http';
import { OauthErreur, echangerCode, renouveler } from '@/lib/mcp/oauth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rate = mcpTokenLimiter.enforce(extractClientIp(request.headers));
  if (!rate.ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...CORS, 'Retry-After': String(rate.retryAfterSeconds) } });
  try {
    const p = await lireParams(request);
    let jetons;
    if (p.grant_type === 'authorization_code') jetons = await echangerCode(prisma, p);
    else if (p.grant_type === 'refresh_token') jetons = await renouveler(prisma, p);
    else throw new OauthErreur('unsupported_grant_type', 'authorization_code ou refresh_token');
    return NextResponse.json(jetons, { headers: { ...CORS, 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (err) {
    return reponseErreur(err);
  }
}

export const OPTIONS = preflight;
