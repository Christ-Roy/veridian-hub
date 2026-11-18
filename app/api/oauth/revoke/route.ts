/** Révocation (RFC 7009) : toujours 200. Coupe la connexion entière du jeton. */
import { NextResponse, type NextRequest } from 'next/server';

import { extractClientIp, mcpTokenLimiter } from '@/lib/auth/rate-limit';
import { CORS } from '@/lib/mcp/config';
import { lireParams, preflight, reponseErreur } from '@/lib/mcp/http';
import { revoquer } from '@/lib/mcp/oauth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rate = mcpTokenLimiter.enforce(extractClientIp(request.headers));
  if (!rate.ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: CORS });
  try {
    const p = await lireParams(request);
    await revoquer(prisma, p.token);
    return new NextResponse(null, { status: 200, headers: CORS });
  } catch (err) {
    return reponseErreur(err);
  }
}

export const OPTIONS = preflight;
