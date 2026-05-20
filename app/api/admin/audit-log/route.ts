/**
 * GET /api/admin/audit-log
 *
 * Endpoint forensics : retourne les dernières actions admin écrites dans
 * `hub_app.audit_log`. Utilisé pour debug "qui a fait quoi quand".
 *
 * Auth : authenticateAdmin (session admin ou x-admin-secret).
 * Query params :
 *  - actor (optionnel) : filtre par actor exact (ex: 'token:ADMIN_SECRET',
 *    'admin:robert@veridian.site'). Si absent, retourne les N derniers
 *    events tous actors confondus.
 *  - limit (default 100, max 500)
 *  - since (optionnel) : ISO date, ne retourne que les events plus récents
 *
 * Utilise l'index `audit_log_actor_created_at_idx` quand `actor` est fourni
 * (lookup O(log n) au lieu du full scan).
 */

import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { findAuditByActor } from '@/lib/admin/audit-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  const url = new URL(request.url);
  const actor = url.searchParams.get('actor');
  const limitRaw = Number(url.searchParams.get('limit') ?? '100');
  const limit = Math.min(Math.max(1, limitRaw), 500);
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw ? new Date(sinceRaw) : undefined;

  // Si actor fourni : query indexée par actor (utilise l'index dédié)
  if (actor) {
    const rows = await findAuditByActor(prisma, actor, { limit, since });
    return NextResponse.json({ actor, count: rows.length, events: rows });
  }

  // Sinon : derniers events tous actors confondus (utilise l'index sur created_at)
  const where: { createdAt?: { gte: Date } } = {};
  if (since) where.createdAt = { gte: since };
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return NextResponse.json({ count: rows.length, events: rows });
}
