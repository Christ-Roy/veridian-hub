/**
 * Cron Job — Détection des users Hub orphelins (DRY-RUN ONLY).
 *
 * Endpoint  : POST /api/cron/cleanup-orphan-users
 * Schedule  : Hebdomadaire (Vercel Cron, GitHub Actions, ou externe)
 * Auth      : header `Authorization: Bearer <CRON_SECRET>`
 *
 * ⚠️ DÉLIBÉRÉMENT PASSIF : ce cron NE SUPPRIME RIEN.
 * Il loggue la liste des users orphelins et retourne le JSON pour audit.
 * Le delete sera fait MANUELLEMENT par un opérateur après revue, et
 * seulement quand la politique de rétention RGPD aura été figée.
 *
 * Voir `lib/admin/find-orphan-users.ts` pour la définition exacte d'un
 * "orphelin" et la protection anti-suppression-de-tenant.
 */

import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { findOrphanUsers } from '@/lib/admin/find-orphan-users';

const CRON_SECRET = process.env.CRON_SECRET;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  if (!CRON_SECRET) {
    console.error(
      JSON.stringify({
        tag: '[cron-orphan-users]',
        level: 'error',
        message: 'CRON_SECRET not configured',
        ts: new Date().toISOString(),
      })
    );
    return NextResponse.json({ error: 'cron_not_configured' }, { status: 500 });
  }

  const authHeader = request.headers.get('authorization');
  const providedSecret = authHeader?.replace('Bearer ', '');
  if (providedSecret !== CRON_SECRET) {
    console.warn(
      JSON.stringify({
        tag: '[cron-orphan-users]',
        level: 'warn',
        message: 'unauthorized',
        ts: new Date().toISOString(),
      })
    );
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const minAgeDays = Number(url.searchParams.get('minAgeDays') ?? '7');
  const limit = Number(url.searchParams.get('limit') ?? '1000');

  const result = await findOrphanUsers(prisma, { minAgeDays, limit });
  const durationMs = Date.now() - startTime;

  // Log structuré pour Grafana Loki
  console.log(
    JSON.stringify({
      tag: '[cron-orphan-users]',
      level: 'info',
      mode: 'dry-run',
      minAgeDays,
      totalOrphans: result.totalOrphans,
      duration_ms: durationMs,
      ts: result.scannedAt,
      // Log les premiers 50 IDs pour debug ; le JSON complet est dans la réponse.
      sample: result.orphans.slice(0, 50).map((o) => ({
        id: o.id,
        ageDays: o.ageDays,
      })),
    })
  );

  return NextResponse.json({
    mode: 'dry-run',
    durationMs,
    ...result,
  });
}
