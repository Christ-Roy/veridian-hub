/**
 * GET /api/admin/tenants/[id]/liaisons : l'état des liaisons d'une organisation, en LECTURE SEULE (aucune poignée, aucune ligne écrite). Sert à vérifier
 * chez un vrai client ce que son écran affiche, sans y toucher (26/11). Ne rend ni adresse ni personne : seulement qui a réglé, oui ou non.
 */
import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/admin/require-admin';
import { listerIntegrations } from '@/lib/delegation/interrupteur';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const id = IdTenant.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  if (!(await prisma.tenant.findFirst({ where: { id: id.data, deletedAt: null }, select: { id: true } }))) return NextResponse.json({ error: 'tenant_introuvable' }, { status: 404 });
  const liaisons = (await listerIntegrations(prisma, id.data)).map(({ change_par, ...l }) => ({ ...l, reglee_par_quelqu_un: change_par !== null }));
  return NextResponse.json({ tenant_id: id.data, liaisons }, { headers: { 'Cache-Control': 'no-store' } });
}
