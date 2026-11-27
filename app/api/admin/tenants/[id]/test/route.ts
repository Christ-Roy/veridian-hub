/** POST /api/admin/tenants/[id]/test { poser } : marque (24 h) ou démarque une organisation de test (VER-245). */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveActor } from '@/lib/admin/audit-log';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { prisma } from '@/lib/prisma';
import { marquerTest } from '@/lib/tenants/marque-test';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.object({ poser: z.boolean() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const garde = await authenticateAdmin(request);
  if (!garde.ok) return garde.response;
  const id = IdTenant.safeParse((await params).id);
  const c = Corps.safeParse(await request.json().catch(() => null));
  if (!id.success || !c.success) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  const r = await marquerTest(prisma, { tenantId: id.data, poser: c.data.poser, acteur: resolveActor(request.headers, null) });
  if ('refus' in r) return NextResponse.json({ error: r.refus }, { status: r.refus === 'compte_reel' ? 403 : 404 });
  return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } });
}
