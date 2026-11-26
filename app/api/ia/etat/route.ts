/**
 * POST { hub_user_id, tenant_id }, signé par l'app avec un nonce (comme /api/organisations/lire) : la fenêtre de l'assistant peut-elle
 * répondre à cette personne dans cette organisation ? CONTRAT-HUB §5.24.1 (parente, 26/11 : une fenêtre qui refuse tout le monde ne
 * s'affiche jamais). `prete` : l'app peut insérer la fenêtre ; `sans_moteur` : elle montre la carte « Relier mon IA » ; `eteinte` :
 * la personne l'a éteinte pour cette app, rien n'est affiché. POST et non GET : la signature porte sur le corps, pas sur la query.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { deborde, verifierAppel } from '@/lib/delegation/jeton';
import { espaceDe } from '@/lib/ia/contexte';
import { APPS_FENETRE, etatFenetre } from '@/lib/ia/etat-fenetre';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAR_MINUTE = 600;
const Corps = z.object({ hub_user_id: z.string().uuid(), tenant_id: z.string().uuid() });
const rendre = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest) {
  const corps = await request.text();
  if (corps.length > 2_000) return rendre({ error: 'invalid_request' }, 400);
  const now = Date.now();
  const v = await verifierAppel(prisma, request.headers, corps, now, APPS_FENETRE);
  if ('statut' in v) return rendre({ error: v.error }, v.statut);
  if (deborde(`ia-etat:${v.app}`, now, PAR_MINUTE)) return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } });
  let brut: unknown = null;
  try { brut = JSON.parse(corps); } catch { /* refusé juste après */ }
  const c = Corps.safeParse(brut);
  if (!c.success) return rendre({ error: 'invalid_request' }, 400);
  // Hors session : le dernier passage de la personne par le fournisseur de son organisation fait foi (§5.19.6).
  const espace = await espaceDe(c.data.hub_user_id, c.data.tenant_id, { par: 'personne' }, { app: v.app, workspaceId: null });
  // Personne inconnue, organisation qui n'est pas la sienne, supprimée : la même réponse, rien n'est dit de plus.
  if (!espace) return rendre({ error: 'espace_inconnu' }, 404);
  return rendre({ etat: await etatFenetre(prisma, { hubUserId: c.data.hub_user_id, app: v.app, tenantId: espace.id }) });
}
