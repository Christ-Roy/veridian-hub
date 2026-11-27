/**
 * GET /api/vivant : le processus répond, rien d'autre. Sonde SUPERFICIELLE du healthcheck Traefik (fiche nomad-veridian 34, VER-270) :
 * jamais la base. Un `/api/health` (qui fait `SELECT 1`, 2 s) en healthcheck retirerait TOUTES les instances dès que la base tousse,
 * et son délai de 2 s dépasse celui de Traefik (1 s). La santé profonde reste `/api/health` : check Nomad, CI, alertes.
 * Hors du middleware (aucune session lue, aucun cookie posé) : voir `middleware.ts`.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
