/**
 * Porte MCP Veridian (docs/CONTRAT-MCP.md) : un seul serveur pour toutes les apps.
 * Streamable HTTP sans état : POST JSON-RPC, réponse JSON. Jeton OAuth du Hub obligatoire.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { mcpCallLimiter } from '@/lib/auth/rate-limit';
import { CORS, resourceMetadataUrl } from '@/lib/mcp/config';
import { verifierAcces } from '@/lib/mcp/oauth';
import { traiter } from '@/lib/mcp/porte';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TAILLE_MAX = 1_000_000;

function nonAutorise(raison: string) {
  return NextResponse.json(
    { error: 'invalid_token', error_description: raison },
    {
      status: 401,
      headers: {
        ...CORS,
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl()}", error="invalid_token", error_description="${raison}"`,
      },
    },
  );
}

export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? '';
  const brut = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!brut) return nonAutorise('jeton absent');
  const qui = await verifierAcces(prisma, brut);
  if (!qui) return nonAutorise('jeton invalide, expiré ou révoqué');

  const rate = mcpCallLimiter.enforce(qui.hubUserId);
  if (!rate.ok) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...CORS, 'Retry-After': String(rate.retryAfterSeconds) } });
  }

  const texte = await request.text();
  if (texte.length > TAILLE_MAX) return NextResponse.json({ error: 'trop_gros' }, { status: 413, headers: CORS });
  let msg: unknown;
  try {
    msg = JSON.parse(texte);
  } catch {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON illisible' } }, { status: 400, headers: CORS });
  }
  if (Array.isArray(msg)) {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'lots JSON-RPC non pris en charge' } }, { status: 400, headers: CORS });
  }
  const reponse = await traiter(prisma, qui, msg as Parameters<typeof traiter>[2]);
  if (reponse === null) return new NextResponse(null, { status: 202, headers: CORS });
  return NextResponse.json(reponse, { headers: CORS });
}

/** Pas de flux serveur → client : la porte est sans état. */
export function GET() {
  return new NextResponse(null, { status: 405, headers: { ...CORS, Allow: 'POST' } });
}

export function DELETE() {
  return new NextResponse(null, { status: 405, headers: { ...CORS, Allow: 'POST' } });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
