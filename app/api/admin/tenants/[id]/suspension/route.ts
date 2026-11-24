/** POST /api/admin/tenants/[id]/suspension { suspendre, motif? } : la porte MCP refuse aussitôt, les apps qui savent suivent (VER-245). */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveActor } from '@/lib/admin/audit-log';
import { requireAdmin } from '@/lib/admin/require-admin';
import { prisma } from '@/lib/prisma';
import { basculerSuspension } from '@/lib/tenants/membres';
import { IdTenant, refuser, rendre } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.object({ suspendre: z.boolean(), motif: z.string().max(200).optional() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const id = IdTenant.safeParse((await params).id);
  const c = Corps.safeParse(await request.json().catch(() => null));
  if (!id.success || !c.success) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  try {
    return rendre(await basculerSuspension(prisma, { tenantId: id.data, ...c.data, acteur: resolveActor(request.headers, null) }));
  } catch (err) {
    return refuser(err);
  }
}
