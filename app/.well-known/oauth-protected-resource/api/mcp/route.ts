/** Métadonnées de la ressource protégée (RFC 9728) : où s'autoriser pour la porte MCP. */
import { NextResponse } from 'next/server';

import { CORS, protectedResourceMetadata } from '@/lib/mcp/config';
import { preflight } from '@/lib/mcp/http';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(protectedResourceMetadata(), { headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' } });
}

export const OPTIONS = preflight;
