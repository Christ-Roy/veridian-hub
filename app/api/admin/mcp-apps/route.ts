/**
 * Registre des MCP d'apps (docs/CONTRAT-MCP.md). Ajouter une app à la porte = une ligne ici,
 * aucun code ni déploiement du Hub. Admin seulement.
 *   GET    : liste
 *   POST   : { app_key, label, mcp_url, acces?: 'tous'|'tenant_app', enabled? } (création ou mise à jour)
 *   DELETE : ?app_key=
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAdmin } from '@/lib/admin/require-admin';
import { viderCache } from '@/lib/mcp/catalogue';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Entree = z.object({
  app_key: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).refine((k) => k !== 'hub', 'clé réservée'),
  label: z.string().min(1).max(60),
  mcp_url: z.string().url().refine((u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(u), 'https obligatoire'),
  acces: z.enum(['tous', 'tenant_app']).default('tenant_app'),
  enabled: z.boolean().default(true),
});

export async function GET(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;
  return NextResponse.json({ apps: await prisma.mcpApp.findMany({ orderBy: { appKey: 'asc' } }) });
}

export async function POST(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;
  const r = Entree.safeParse(await request.json().catch(() => null));
  if (!r.success) return NextResponse.json({ error: 'invalid', details: r.error.issues }, { status: 400 });
  const d = r.data;
  const data = { label: d.label, mcpUrl: d.mcp_url, acces: d.acces, enabled: d.enabled };
  const app = await prisma.mcpApp.upsert({ where: { appKey: d.app_key }, create: { appKey: d.app_key, ...data }, update: data });
  await prisma.auditLog.create({ data: { action: 'admin.mcp_app.upsert', actor: 'admin', targetType: 'mcp_app', targetId: d.app_key, payload: data } });
  viderCache();
  return NextResponse.json({ app });
}

export async function DELETE(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;
  const cle = request.nextUrl.searchParams.get('app_key') ?? '';
  const n = await prisma.mcpApp.deleteMany({ where: { appKey: cle } });
  await prisma.auditLog.create({ data: { action: 'admin.mcp_app.delete', actor: 'admin', targetType: 'mcp_app', targetId: cle } });
  viderCache();
  return NextResponse.json({ supprimees: n.count });
}
