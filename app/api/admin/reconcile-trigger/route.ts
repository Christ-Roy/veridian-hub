/**
 * POST /api/admin/reconcile-trigger
 *
 * Wrapper admin du `runReconcile()` (lib/sync/reconcile.ts) — bouton
 * "Lancer audit cross-app" dans `/dashboard/admin`.
 *
 * Forcé en mode dry-run (autoRepair: false) : tant que les endpoints
 * discovery downstream ne sont pas tous livrés, un auto-repair effacerait
 * en masse les cards UI Hub (cf doc lib/sync/reconcile.ts P0 lock).
 *
 * Auth : `authenticateAdmin` (session + rate-limit).
 *
 * Body : aucun (POST sans body OK).
 * Response 200 : `ReconcileSummary` brut (cf lib/sync/types.ts).
 * Response 4xx : `{ error }`.
 *
 * Pas de cache : chaque clic = call live. Pas de persistance.
 */

import { NextRequest, NextResponse } from 'next/server';

import { authenticateAdmin } from '@/lib/admin/authenticate';
import { runReconcile } from '@/lib/sync/reconcile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  try {
    const summary = await runReconcile({ autoRepair: false });
    return NextResponse.json(summary);
  } catch (err) {
    console.error('[admin/reconcile-trigger] runReconcile failed:', err);
    return NextResponse.json(
      {
        error: 'reconcile_failed',
        message: err instanceof Error ? err.message : 'unknown error',
      },
      { status: 500 },
    );
  }
}
