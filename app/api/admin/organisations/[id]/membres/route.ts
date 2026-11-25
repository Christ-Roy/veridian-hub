/** POST { membres: [{ email, role? }], a_blanc? } : importe des membres dans l'organisation, un passage, une émission (VER-252). 207 : une ligne non jointe ou une app en retard. */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveActor } from '@/lib/admin/audit-log';
import { requireAdmin } from '@/lib/admin/require-admin';
import { LIMITE_IMPORT, importerMembres } from '@/lib/organisations/importer';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.object({
  membres: z.array(z.object({ email: z.string().max(254), role: z.string().max(20).optional() })).min(1).max(LIMITE_IMPORT),
  /** Essai : dit ce que chaque ligne deviendrait, n'écrit rien, n'émet rien. */
  a_blanc: z.boolean().optional(),
}).strict();

type Ctx = { params: Promise<{ id: string }> };
const rendre = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest, { params }: Ctx) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const id = IdTenant.safeParse((await params).id);
  const c = Corps.safeParse(await request.json().catch(() => null));
  if (!id.success || !c.success) return rendre({ error: 'invalid' }, 400);
  const r = await importerMembres(prisma, { tenantId: id.data, membres: c.data.membres, acteur: resolveActor(request.headers, null), aBlanc: c.data.a_blanc === true });
  if ('refus' in r) return rendre({ error: r.refus }, 404);
  const compte: Record<string, number> = {};
  for (const l of r.lignes) compte[l.etat] = (compte[l.etat] ?? 0) + 1;
  const bien = r.lignes.every((l) => l.etat === 'joint' || l.etat === 'deja') && r.organisation.every((e) => e.etat === 'applique');
  return rendre({ compte, lignes: r.lignes, organisation: r.organisation, a_blanc: c.data.a_blanc === true }, bien ? 200 : 207);
}
