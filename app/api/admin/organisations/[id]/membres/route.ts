/**
 * GET : les adresses pré-inscrites et leur état. DELETE { email } : annule celle qui attend encore.
 * POST { membres: [{ email, role? }], a_blanc? } : importe des membres dans l'organisation, un passage, une émission (VER-252). 207 : une ligne non jointe ou une app en retard.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveActor, writeAuditLog } from '@/lib/admin/audit-log';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { LIMITE_IMPORT, importerMembres } from '@/lib/organisations/importer';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';
import { annulerPreinscriptions, listerPreinscriptions } from '@/lib/tenants/preinscription';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.object({
  membres: z.array(z.object({ email: z.string().max(254), role: z.string().max(20).optional() })).min(1).max(LIMITE_IMPORT),
  /** Essai : dit ce que chaque ligne deviendrait, n'écrit rien, n'émet rien. */
  a_blanc: z.boolean().optional(),
  /** Les pré-inscrits gardent leur accès habituel jusqu'au rattachement (VER-261). */
  exempter: z.boolean().optional(),
}).strict();

type Ctx = { params: Promise<{ id: string }> };
const rendre = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest, { params }: Ctx) {
  const garde = await authenticateAdmin(request);
  if (!garde.ok) return garde.response;
  const id = IdTenant.safeParse((await params).id);
  const c = Corps.safeParse(await request.json().catch(() => null));
  if (!id.success || !c.success) return rendre({ error: 'invalid' }, 400);
  const r = await importerMembres(prisma, { tenantId: id.data, membres: c.data.membres, acteur: resolveActor(request.headers, null), aBlanc: c.data.a_blanc === true, exempter: c.data.exempter === true });
  if ('refus' in r) return rendre({ error: r.refus }, 404);
  const compte: Record<string, number> = {};
  for (const l of r.lignes) compte[l.etat] = (compte[l.etat] ?? 0) + 1;
  const bien = r.lignes.every((l) => l.etat === 'joint' || l.etat === 'deja' || l.etat === 'preinscrit') && r.organisation.every((e) => e.etat === 'applique');
  return rendre({ compte, lignes: r.lignes, organisation: r.organisation, a_blanc: c.data.a_blanc === true }, bien ? 200 : 207);
}

export async function GET(request: NextRequest, { params }: Ctx) {
  const garde = await authenticateAdmin(request);
  if (!garde.ok) return garde.response;
  const id = IdTenant.safeParse((await params).id);
  if (!id.success) return rendre({ error: 'invalid' }, 400);
  return rendre({ preinscrits: await listerPreinscriptions(prisma, id.data) });
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const garde = await authenticateAdmin(request);
  if (!garde.ok) return garde.response;
  const id = IdTenant.safeParse((await params).id);
  const c = z.object({ email: z.string().email().max(254) }).strict().safeParse(await request.json().catch(() => null));
  if (!id.success || !c.success) return rendre({ error: 'invalid' }, 400);
  const annulees = await annulerPreinscriptions(prisma, { tenantId: id.data, email: c.data.email });
  if (annulees) await writeAuditLog(prisma, { action: 'preinscription.annulee', actor: resolveActor(request.headers, null), targetType: 'tenant', targetId: id.data });
  return rendre({ annulees });
}
