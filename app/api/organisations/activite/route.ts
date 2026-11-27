/** POST { hub_tenant_id, hub_user_id, prefixe, depuis }, signé par Academy avec un nonce : le membre a-t-il fait appeler cet outil ? (VER-252) */
import { NextRequest, NextResponse } from 'next/server';

import { deborde, verifierAppel } from '@/lib/delegation/jeton';
import { activite, activiteOuverte, DemandeActivite } from '@/lib/organisations/activite';
import { hubPublicUrl } from '@/lib/organisations/base';
import { documentOrg } from '@/lib/organisations/document';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const rendre = (j: unknown, status = 200, h: Record<string, string> = {}) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store', ...h } });

export async function POST(request: NextRequest) {
  const corps = await request.text();
  if (corps.length > 2_000) return rendre({ error: 'invalid_request' }, 400);
  const v = await verifierAppel(prisma, request.headers, corps, Date.now(), ['academy'] as const);
  if ('statut' in v) return rendre({ error: v.error }, v.statut);
  if ((await deborde(`activite:${v.app}`, Date.now(), 120))) return rendre({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
  let brut: unknown = null;
  try { brut = JSON.parse(corps); } catch { /* refusé juste après */ }
  const c = DemandeActivite.safeParse(brut);
  if (!c.success) return rendre({ error: 'invalid_request' }, 400);
  // Fermée, inconnue, ou qui n'a pas coché l'app : la même réponse, pour ne rien dire de plus.
  const d = activiteOuverte(c.data.hub_tenant_id) ? await documentOrg(prisma, c.data.hub_tenant_id, hubPublicUrl()) : null;
  if (!d || !d.modules.includes(v.app)) return rendre({ error: 'organisation_introuvable' }, 404);
  const r = await activite(prisma, c.data);
  if ('refus' in r) return rendre({ error: r.refus }, r.refus === 'depuis_invalide' ? 400 : 404);
  return rendre(r);
}
