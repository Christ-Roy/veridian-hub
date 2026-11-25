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
 *  - action (optionnel) : une ou plusieurs actions exactes, séparées par des virgules (25/11 : la batterie remplit 500 lignes
 *    en quatre heures, un geste rare ne se retrouvait plus)
 *  - apres (optionnel) : id rendu par `suivant`, pour la page d'après
 * `couverture` dit ce que le journal entier contient et depuis quand : une absence ne se lit qu'avec elle.
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
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.trunc(limitRaw)), 500) : 100;
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  if (since && Number.isNaN(since.getTime())) return NextResponse.json({ error: 'since_invalide' }, { status: 400 });
  const actions = (url.searchParams.get('action') ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const apres = url.searchParams.get('apres');

  // Si actor fourni : query indexée par actor (utilise l'index dédié)
  if (actor) {
    if (actions.length || apres) return NextResponse.json({ error: 'actor_seul' }, { status: 400 });
    const rows = await findAuditByActor(prisma, actor, { limit, since });
    return NextResponse.json({ actor, count: rows.length, events: rows });
  }

  if (apres && !(await prisma.auditLog.findUnique({ where: { id: apres }, select: { id: true } }))) return NextResponse.json({ error: 'apres_inconnu' }, { status: 400 });
  const where = { ...(since ? { createdAt: { gte: since } } : {}), ...(actions.length ? { action: { in: actions } } : {}) };
  const [rows, filtre, tout] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, ...(apres ? { cursor: { id: apres }, skip: 1 } : {}) }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.aggregate({ _count: { _all: true }, _min: { createdAt: true } }),
  ]);
  return NextResponse.json({ count: rows.length, filtre, suivant: rows.length === limit ? rows[rows.length - 1].id : null, couverture: { total: tout._count._all, depuis: tout._min.createdAt }, events: rows });
}
