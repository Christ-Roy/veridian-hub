/**
 * POST /api/admin/alerte-test : écrit une alerte libellée « essai » sur stdout et dit la ligne écrite.
 *
 * Le contrôle du chemin d'alerte du Hub (Grafana seule source, plus de Telegram : Robert, 23/11 puis 27/11). Preuve de bout en bout :
 * relire la ligne dans Loki (`container="hub"`, `flux=alerte`). Admin seulement.
 * - sans corps : une ligne `info` (`hub.alerte_test`) : prouve la lecture du JSON, ne réveille personne ;
 * - `{"gravite":"critique"}` : une ligne `critique`, `impact=client`, `evenement` préfixé `ESSAI-` : fait rougir la règle
 *   `vrd-hub-alerte-critique` (infra, 27/11), donc un mail d'urgence libellé ESSAI. À n'envoyer que pour éprouver la règle.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticateAdmin } from '@/lib/admin/authenticate';
import { construireAlerte } from '@/lib/notifications/alerte';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Corps = z.object({ gravite: z.enum(['info', 'critique']).default('info') }).strict();

export async function POST(request: NextRequest) {
  const garde = await authenticateAdmin(request);
  if (!garde.ok) return garde.response;
  const brut = (await request.text()).trim();
  let json: unknown = {};
  try {
    if (brut) json = JSON.parse(brut);
  } catch {
    json = null;
  }
  const lu = Corps.safeParse(json);
  if (!lu.success) return NextResponse.json({ error: 'invalid_request', message: 'corps attendu : {} ou {"gravite":"critique"}' }, { status: 400 });
  const critique = lu.data.gravite === 'critique';
  const ligne = construireAlerte(
    critique
      ? { gravite: 'critique', impact: 'client', evenement: 'ESSAI-hub.alerte_test', message: 'ESSAI de la règle d\'alerte critique du Hub. Aucun client touché, aucune action à faire.' }
      : { gravite: 'info', evenement: 'hub.alerte_test', message: 'Alerte de contrôle du Hub. Aucune action à faire.' },
  );
  console.log(JSON.stringify(ligne));
  return NextResponse.json({ emitted: true, gravite: ligne.gravite, evenement: ligne.evenement, dedup: ligne.dedup, ts: ligne.ts });
}
