/**
 * GET /api/admin/programmes?depuis=<ISO>  (défaut : 24 h)
 *
 * Les programmes de la porte MCP : en cours, perdus, terminés (essai / client), dernier programme client. Lecture seule, aucune
 * adresse ni aucun code rendu (`lib/mcp/programmes-lus.ts`). Sert à choisir une fenêtre avant de remplacer le moteur (cas 20).
 */
import { NextRequest, NextResponse } from 'next/server';

import { authenticateAdmin } from '@/lib/admin/authenticate';
import { lireProgrammes, type DbProgrammes } from '@/lib/mcp/programmes-lus';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOUR_MS = 24 * 3600_000;

export async function GET(request: NextRequest) {
  const auth = await authenticateAdmin(request);
  if (!auth.ok) return auth.response;
  const brut = new URL(request.url).searchParams.get('depuis');
  const depuis = brut ? new Date(brut) : new Date(Date.now() - JOUR_MS);
  if (Number.isNaN(depuis.getTime())) return NextResponse.json({ error: 'depuis_invalide' }, { status: 400 });
  return NextResponse.json(await lireProgrammes(prisma as unknown as DbProgrammes, depuis));
}
