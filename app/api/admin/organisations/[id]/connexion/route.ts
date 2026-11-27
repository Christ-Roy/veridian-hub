/**
 * Connexion d'une organisation, opérateur seulement (VER-261, `hub org connexion`). GET : qui entre comment. PUT { obligatoire?, aiguillage? }.
 * POST { hub_user_id, nature } : garder l'accès actuel de quelqu'un, ou en faire un accès de secours. DELETE { hub_user_id } : le lever.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveActor } from '@/lib/admin/audit-log';
import { requireAdmin } from '@/lib/admin/require-admin';
import { Aiguillage, etatConnexion, leverExemption, poserExemption, reglerConnexion } from '@/lib/federation/connexion';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

type Ctx = { params: Promise<{ id: string }> };
const rendre = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store' } });
const Regle = z.strictObject({ obligatoire: z.boolean().optional(), aiguillage: Aiguillage.optional() }).refine((r) => r.obligatoire !== undefined || r.aiguillage !== undefined);
const Pose = z.strictObject({ hub_user_id: z.string().uuid(), nature: z.enum(['rattachement', 'secours']) });
const Leve = z.strictObject({ hub_user_id: z.string().uuid() });

async function entree<T>(request: NextRequest, ctx: Ctx, schema: z.ZodType<T> | null): Promise<{ refus: NextResponse } | { id: string; corps: T }> {
  const refus = await requireAdmin(request);
  if (refus) return { refus };
  const id = IdTenant.safeParse((await ctx.params).id);
  const c = schema ? schema.safeParse(await request.json().catch(() => null)) : null;
  if (!id.success || (c && !c.success)) return { refus: rendre({ error: 'invalid' }, 400) };
  return { id: id.data, corps: c?.data as T };
}
const statut = (refus: string): number => (refus === 'tenant_introuvable' || refus === 'absente' || refus === 'pas_membre' ? 404 : 409);

export async function GET(request: NextRequest, ctx: Ctx) {
  const e = await entree(request, ctx, null);
  return 'refus' in e ? e.refus : rendre(await etatConnexion(prisma, e.id));
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  const e = await entree(request, ctx, Regle);
  if ('refus' in e) return e.refus;
  const r = await reglerConnexion(prisma, { tenantId: e.id, ...e.corps, acteur: resolveActor(request.headers, null) });
  return 'refus' in r ? rendre({ error: r.refus }, statut(r.refus)) : rendre({ ...(await etatConnexion(prisma, e.id)), sessions_d_app_coupees: r.coupes });
}

export async function POST(request: NextRequest, ctx: Ctx) {
  const e = await entree(request, ctx, Pose);
  if ('refus' in e) return e.refus;
  const r = await poserExemption(prisma, { tenantId: e.id, hubUserId: e.corps.hub_user_id, nature: e.corps.nature, acteur: resolveActor(request.headers, null) });
  return 'refus' in r ? rendre({ error: r.refus }, statut(r.refus)) : rendre(await etatConnexion(prisma, e.id));
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  const e = await entree(request, ctx, Leve);
  if ('refus' in e) return e.refus;
  const r = await leverExemption(prisma, { tenantId: e.id, hubUserId: e.corps.hub_user_id, acteur: resolveActor(request.headers, null) });
  return 'refus' in r ? rendre({ error: r.refus }, statut(r.refus)) : rendre(await etatConnexion(prisma, e.id));
}
