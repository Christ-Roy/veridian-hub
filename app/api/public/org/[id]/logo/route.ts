/** GET : le logo d'une organisation, PNG réencodé par le Hub. Public, versionné par son empreinte : l'adresse change avec le logo. */
import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = IdTenant.safeParse((await params).id);
  const o = id.success ? await prisma.organisation.findUnique({ where: { tenantId: id.data }, select: { logo: true, logoEmpreinte: true } }) : null;
  if (!o?.logo || new URL(request.url).searchParams.get('v') !== o.logoEmpreinte) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(o.logo), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'cross-origin' },
  });
}
