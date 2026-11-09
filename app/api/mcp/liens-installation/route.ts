/**
 * Liens « Ajouter à … » de la porte MCP, en lecture publique : chaque app affiche les boutons chez elle
 * sans recopier leur logique, qui reste ici. Aucun secret dans ces liens, aucun cookie lu.
 */
import { NextResponse } from 'next/server';

import { CORS } from '@/lib/mcp/config';
import { liensInstallation } from '@/lib/mcp/liens-installation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EN_TETES = { ...CORS, 'Cache-Control': 'public, max-age=300' };

export function GET() {
  return NextResponse.json(liensInstallation(), { headers: EN_TETES });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: EN_TETES });
}
