/** POST { hub_tenant_id }, signé par l'app avec un nonce (comme /api/delegation) : le document courant, pour le rattrapage (VER-252). */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { verifierAppel } from '@/lib/delegation/jeton';
import { hubPublicUrl } from '@/lib/organisations/base';
import { documentOrg, MODULES, pourApp, type Module } from '@/lib/organisations/document';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.object({ hub_tenant_id: z.string().uuid() });
const rendre = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest) {
  const corps = await request.text();
  if (corps.length > 2_000) return rendre({ error: 'invalid_request' }, 400);
  const v = await verifierAppel(prisma, request.headers, corps, Date.now(), MODULES);
  if ('statut' in v) return rendre({ error: v.error }, v.statut);
  let brut: unknown = null;
  try { brut = JSON.parse(corps); } catch { /* refusé juste après */ }
  const c = Corps.safeParse(brut);
  if (!c.success) return rendre({ error: 'invalid_request' }, 400);
  const d = await documentOrg(prisma, c.data.hub_tenant_id, hubPublicUrl());
  // Une app ne lit que les organisations qui l'ont cochée ; les autres n'existent pas pour elle.
  if (!d || !d.modules.includes(v.app as Module)) return rendre({ error: 'organisation_introuvable' }, 404);
  return rendre(pourApp(d, v.app));
}
