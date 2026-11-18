/**
 * Liens « Ajouter à … » de la porte MCP, en lecture publique : chaque app affiche les boutons chez elle
 * sans recopier leur logique, qui reste ici. Aucun secret ni donnée personnelle, aucun cookie lu.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { CORS } from '@/lib/mcp/config';
import { liensPublics } from '@/lib/mcp/liens-installation';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EN_TETES = { ...CORS, 'Cache-Control': 'public, max-age=300' };

export async function GET(req: NextRequest) {
  const corps = await liensPublics(prisma, req.nextUrl.searchParams.get('app'));
  return NextResponse.json(corps, { headers: EN_TETES });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: EN_TETES });
}
