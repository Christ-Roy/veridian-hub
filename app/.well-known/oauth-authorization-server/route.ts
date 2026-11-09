/** Métadonnées du serveur d'autorisation (RFC 8414). */
import { NextResponse } from 'next/server';

import { CORS, authorizationServerMetadata } from '@/lib/mcp/config';
import { preflight } from '@/lib/mcp/http';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(authorizationServerMetadata(), { headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' } });
}

export const OPTIONS = preflight;
