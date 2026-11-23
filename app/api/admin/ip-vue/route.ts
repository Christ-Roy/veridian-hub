/**
 * GET /api/admin/ip-vue : l'adresse que le Hub retient pour CET appel, et comment (lib/auth/ip-client.ts). Admin seulement.
 * Sert à mesurer, sans rafale, que l'appelant ne choisit pas sa clé et que les visiteurs ne partagent pas celle de Cloudflare.
 */
import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/admin/require-admin';
import { cleIp, vueIp } from '@/lib/auth/ip-client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  return NextResponse.json({ cle: cleIp(request.headers), ...vueIp(request.headers) });
}
