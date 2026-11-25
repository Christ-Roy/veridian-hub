/** Fournisseur d'identité d'une organisation (VER-227 S2), opérateur seulement. GET sans secret, PUT, DELETE (les comptes restent, la porte se ferme). */
import { NextRequest, NextResponse } from 'next/server';

import { resolveActor, writeAuditLog } from '@/lib/admin/audit-log';
import { requireAdmin } from '@/lib/admin/require-admin';
import { poserIdp, ReglageIdp, vueIdp } from '@/lib/federation/idp';
import { CHEMIN_RETOUR } from '@/lib/federation/oidc';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };
const rendre = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { 'Cache-Control': 'no-store' } });

async function vue(request: NextRequest, tenantId: string) {
  const i = await prisma.tenantIdp.findUnique({ where: { tenantId } });
  const t = await prisma.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { slug: true } });
  const base = getHubBaseUrl(request.url);
  return { idp: i ? vueIdp(i) : null, connexion: t?.slug ? new URL(`/connexion/${t.slug}`, base).href : null, retour: new URL(CHEMIN_RETOUR, base).href };
}

export async function GET(request: NextRequest, { params }: Ctx) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const id = IdTenant.safeParse((await params).id);
  return id.success ? rendre(await vue(request, id.data)) : rendre({ error: 'invalid' }, 400);
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const id = IdTenant.safeParse((await params).id);
  const c = ReglageIdp.safeParse(await request.json().catch(() => null));
  if (!id.success || !c.success) return rendre({ error: 'invalid' }, 400);
  const acteur = resolveActor(request.headers, null);
  const r = await poserIdp(prisma, { tenantId: id.data, reglage: c.data, acteur });
  if ('refus' in r) return rendre({ error: r.refus }, r.refus === 'tenant_introuvable' ? 404 : 409);
  await writeAuditLog(prisma, { action: 'federation.idp_pose', actor: acteur, targetType: 'tenant', targetId: id.data, payload: { issuer: c.data.issuer, domaines: c.data.domaines, creation_auto: c.data.creation_auto, actif: c.data.actif } });
  return rendre(await vue(request, id.data));
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const id = IdTenant.safeParse((await params).id);
  if (!id.success) return rendre({ error: 'invalid' }, 400);
  const { count } = await prisma.tenantIdp.deleteMany({ where: { tenantId: id.data } });
  if (count) await writeAuditLog(prisma, { action: 'federation.idp_retire', actor: resolveActor(request.headers, null), targetType: 'tenant', targetId: id.data });
  return rendre({ retires: count });
}
