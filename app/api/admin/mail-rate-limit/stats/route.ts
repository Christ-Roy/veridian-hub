/**
 * GET /api/admin/mail-rate-limit/stats
 *
 * Monitoring du rate-limit per-recipient Mail Gateway v2. Robert-only
 * (admin secret ou session admin). Sert le dashboard Hub interne.
 *
 * Auth : `authenticateAdmin` (x-admin-secret OU session admin) — voir
 * `lib/admin/authenticate.ts`.
 *
 * Réponse 200 :
 * ```
 * {
 *   window_minutes: 20,
 *   total_events_24h: number,
 *   top_recipients_blocked: [{ email, count }],   // 10 max, desc
 *   top_senders: [{ user_id, count }]              // 10 max, desc
 * }
 * ```
 *
 * Spec ticket : `todo/2026-05-25-mail-provider-status-endpoint.md` §4 audit.
 *
 * No cache : données monitoring temps-réel.
 */

import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { MAIL_RATE_LIMIT_WINDOW_MS } from '@/lib/mail/rate-limit-recipient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;
const TOP_N = 10;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  const auth = await authenticateAdmin(request);
  if (!auth.ok) return auth.response;

  const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS);

  // Total events 24h
  const totalEvents24h = await prisma.mailRateLimitEvent.count({
    where: { timestamp: { gte: since } },
  });

  // Top destinataires bloqués 24h
  const topRecipientsRaw = await prisma.mailRateLimitEvent.groupBy({
    by: ['recipientEmail'],
    where: { timestamp: { gte: since } },
    _count: { _all: true },
    orderBy: { _count: { recipientEmail: 'desc' } },
    take: TOP_N,
  });

  // Top senders bloqués 24h
  const topSendersRaw = await prisma.mailRateLimitEvent.groupBy({
    by: ['senderUserId'],
    where: { timestamp: { gte: since } },
    _count: { _all: true },
    orderBy: { _count: { senderUserId: 'desc' } },
    take: TOP_N,
  });

  return NextResponse.json(
    {
      window_minutes: MAIL_RATE_LIMIT_WINDOW_MS / 60_000,
      total_events_24h: totalEvents24h,
      top_recipients_blocked: topRecipientsRaw.map((r) => ({
        email: r.recipientEmail,
        count: r._count._all,
      })),
      top_senders: topSendersRaw.map((s) => ({
        user_id: s.senderUserId,
        count: s._count._all,
      })),
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
