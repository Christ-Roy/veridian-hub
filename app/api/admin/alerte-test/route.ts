/**
 * POST /api/admin/alerte-test : écrit une alerte `info` libellée « test » sur stdout et dit la ligne écrite.
 *
 * Le contrôle du chemin d'alerte du Hub (Grafana seule source, plus de Telegram : Robert, 23/11 puis 27/11). Preuve de bout en bout :
 * relire la ligne dans Loki (`obs search`, `flux=alerte` et `evenement=hub.alerte_test`). Admin seulement.
 */
import { NextRequest, NextResponse } from 'next/server';

import { authenticateAdmin } from '@/lib/admin/authenticate';
import { construireAlerte } from '@/lib/notifications/alerte';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const garde = await authenticateAdmin(request);
  if (!garde.ok) return garde.response;
  const ligne = construireAlerte({
    gravite: 'info',
    evenement: 'hub.alerte_test',
    message: 'Alerte de contrôle du Hub. Aucune action à faire.',
  });
  console.log(JSON.stringify(ligne));
  return NextResponse.json({ emitted: true, dedup: ligne.dedup, ts: ligne.ts });
}
