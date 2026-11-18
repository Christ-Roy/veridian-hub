/** Enregistrement dynamique d'un client IA (RFC 7591). Public, limité par IP. */
import { NextResponse, type NextRequest } from 'next/server';

import { extractClientIp, mcpRegisterLimiter } from '@/lib/auth/rate-limit';
import { CORS } from '@/lib/mcp/config';
import { preflight, reponseErreur } from '@/lib/mcp/http';
import { enregistrerClient } from '@/lib/mcp/oauth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const rate = mcpRegisterLimiter.enforce(extractClientIp(request.headers));
  if (!rate.ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...CORS, 'Retry-After': String(rate.retryAfterSeconds) } });
  try {
    const meta = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!meta || typeof meta !== 'object') return NextResponse.json({ error: 'invalid_client_metadata' }, { status: 400, headers: CORS });
    return NextResponse.json(await enregistrerClient(prisma, meta), { status: 201, headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (err) {
    return reponseErreur(err);
  }
}

export const OPTIONS = preflight;
