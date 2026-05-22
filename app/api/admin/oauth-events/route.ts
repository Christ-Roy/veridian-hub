/**
 * GET /api/admin/oauth-events
 *
 * Timeline forensics des connexions OAuth (table hub_app.oauth_signin_events).
 * Sert à investiguer "qui s'est connecté quand", repérer un pic d'échecs
 * (brute-force, provider en panne), auditer un compte précis.
 *
 * Auth : authenticateAdmin (session admin OU x-admin-secret) — protège aussi
 * contre CVE-2025-29927 : le check se fait côté route Node, pas seulement
 * dans le middleware Edge. Inclut le rate-limit adminApiLimiter (30/min/IP).
 *
 * Query params (tous optionnels) :
 *  - provider : filtre exact ('google' | 'microsoft-entra-id' | 'mock-oauth')
 *  - event    : filtre exact ('success' | 'failure')
 *  - email    : filtre exact — exerce l'index oauth_signin_events_email_idx
 *  - limit    : taille de page (default 100, clamp 1..500)
 *  - cursor   : id de la dernière row de la page précédente (pagination
 *               keyset, stable même si de nouvelles rows arrivent en tête)
 *
 * Tri : created_at DESC — exerce l'index oauth_signin_events_created_at_idx.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { authenticateAdmin } from '@/lib/admin/authenticate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Valeurs acceptées pour ?event= — toute autre valeur est ignorée (pas 400,
 *  on dégrade en "pas de filtre" pour rester tolérant côté outillage). */
const VALID_EVENTS = new Set(['success', 'failure']);

export async function GET(request: NextRequest) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  const url = new URL(request.url);
  const provider = url.searchParams.get('provider')?.trim() || undefined;
  const eventRaw = url.searchParams.get('event')?.trim() || undefined;
  const event = eventRaw && VALID_EVENTS.has(eventRaw) ? eventRaw : undefined;
  const email = url.searchParams.get('email')?.trim() || undefined;
  const cursor = url.searchParams.get('cursor')?.trim() || undefined;

  const limitRaw = Number(url.searchParams.get('limit') ?? '100');
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(1, Math.trunc(limitRaw)), 500)
    : 100;

  const where: Prisma.OauthSigninEventWhereInput = {};
  if (provider) where.provider = provider;
  if (event) where.event = event;
  if (email) where.email = email;

  // Pagination keyset : on demande limit+1 rows pour savoir s'il reste une
  // page, et on `skip: 1` le cursor lui-même. Plus stable qu'un offset quand
  // la table prend des inserts en tête en continu.
  const rows = await prisma.oauthSigninEvent.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? events[events.length - 1]?.id ?? null : null;

  return NextResponse.json({
    count: events.length,
    has_more: hasMore,
    next_cursor: nextCursor,
    filters: { provider: provider ?? null, event: event ?? null, email: email ?? null },
    events,
  });
}
