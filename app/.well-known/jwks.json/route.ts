/** Clé publique avec laquelle les apps vérifient l'identité que la porte MCP leur présente. */
import { NextResponse } from 'next/server';

import { CORS } from '@/lib/mcp/config';
import { jwksPublic } from '@/lib/mcp/identite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await jwksPublic(), { headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' } });
}
