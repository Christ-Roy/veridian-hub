/** PUT (octets d'image) : le logo, réencodé par le Hub, puis émis. DELETE : le retire (VER-252). */
import { NextRequest, NextResponse } from 'next/server';

import { resolveActor } from '@/lib/admin/audit-log';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { LOGO_MAX_OCTETS } from '@/lib/organisations/logo';
import { reglerOrganisation } from '@/lib/organisations/reglage';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

async function poser(request: NextRequest, ctx: Ctx, logo: Buffer | null): Promise<NextResponse> {
  const id = IdTenant.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  const r = await reglerOrganisation(prisma, { tenantId: id.data, reglage: {}, logo, acteur: resolveActor(request.headers, null) });
  if ('refus' in r) return NextResponse.json({ error: r.refus }, { status: r.refus === 'tenant_introuvable' ? 404 : r.refus === 'trop_gros' ? 413 : 415 });
  return NextResponse.json(r, { status: r.emissions.every((e) => e.etat === 'applique') ? 200 : 207 });
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  const garde = await authenticateAdmin(request);
  if (!garde.ok) return garde.response;
  if (Number(request.headers.get('content-length') ?? 0) > LOGO_MAX_OCTETS) return NextResponse.json({ error: 'trop_gros' }, { status: 413 });
  return poser(request, ctx, Buffer.from(await request.arrayBuffer()));
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  const garde = await authenticateAdmin(request);
  if (!garde.ok) return garde.response;
  return poser(request, ctx, null);
}
