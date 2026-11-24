/** GET : le document et ce que chaque app sert. PUT : règle l'organisation, émet, rend l'issue par app (VER-252). 207 : une app n'a pas suivi. */
import { NextRequest, NextResponse } from 'next/server';

import { resolveActor } from '@/lib/admin/audit-log';
import { requireAdmin } from '@/lib/admin/require-admin';
import { hubPublicUrl } from '@/lib/organisations/base';
import { documentOrg } from '@/lib/organisations/document';
import { Reglage, reglerOrganisation } from '@/lib/organisations/reglage';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };
const rendre = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: NextRequest, { params }: Ctx) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const id = IdTenant.safeParse((await params).id);
  if (!id.success) return rendre({ error: 'invalid' }, 400);
  const d = await documentOrg(prisma, id.data, hubPublicUrl());
  if (!d) return rendre({ error: 'organisation_non_reglee' }, 404);
  const e = await prisma.organisationEmission.findMany({ where: { tenantId: id.data } });
  return rendre({ document: d, emissions: e.map((x) => ({ app: x.app, version: Number(x.version), a_jour: Number(x.version) === d.version && x.etat === 'applique', etat: x.etat, detail: x.detail, le: x.le.toISOString() })) });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const id = IdTenant.safeParse((await params).id);
  const c = Reglage.safeParse(await request.json().catch(() => null));
  if (!id.success || !c.success) return rendre({ error: 'invalid', details: c.success ? undefined : c.error.issues.map((i) => i.path.join('.')) }, 400);
  const r = await reglerOrganisation(prisma, { tenantId: id.data, reglage: c.data, acteur: resolveActor(request.headers, null) });
  if ('refus' in r) return rendre({ error: r.refus }, 404);
  return rendre(r, r.emissions.every((e) => e.etat === 'applique') ? 200 : 207);
}
