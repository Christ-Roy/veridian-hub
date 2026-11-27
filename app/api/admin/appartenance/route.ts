/**
 * GET /api/admin/appartenance?app=<app> : qui est membre de quoi, dans l'app et au Hub (lib/sync/appartenance.ts).
 * Lecture seule, admin seulement : la réponse porte des adresses, elle ne va jamais dans un log de CI (dépôt public).
 * Une app par appel : Cloudflare coupe une réponse vers 100 s.
 */
import { NextRequest, NextResponse } from 'next/server';

import { authenticateAdmin } from '@/lib/admin/authenticate';
import { prisma } from '@/lib/prisma';
import { releverAppartenance } from '@/lib/sync/appartenance';
import { SYNC_APPS, type SyncApp } from '@/lib/sync/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const garde = await authenticateAdmin(request);
  if (!garde.ok) return garde.response;
  const app = new URL(request.url).searchParams.get('app');
  if (!app || !SYNC_APPS.includes(app as SyncApp)) return NextResponse.json({ error: 'app_inconnue', apps: SYNC_APPS }, { status: 400 });
  return NextResponse.json(await releverAppartenance(prisma, app as SyncApp), { headers: { 'Cache-Control': 'no-store' } });
}
