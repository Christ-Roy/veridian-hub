/**
 * Cron Job — Réconciliation tenants Hub ↔ apps downstream (Niveau 3 du
 * tenant sync, cf `todo/2026-05-20-tenant-sync-strategy.md`).
 *
 * Endpoint  : POST /api/cron/reconcile-tenants
 * Schedule  : Toutes les heures (`.github/workflows/hub-reconcile-cron.yml`)
 * Auth      : header `Authorization: Bearer <CRON_SECRET>`
 *
 * Thin wrapper autour de `runReconcile` (auth Bearer + dispatch). Toute la
 * logique métier est dans `lib/sync/reconcile.ts` pour permettre les tests
 * unitaires (Next.js App Router refuse les exports arbitraires).
 *
 * MODE DRY-RUN ONLY (P0). Aucune écriture côté Hub. Le résultat est :
 *   - logué (Grafana Loki via console.log structuré)
 *   - renvoyé en JSON pour audit immédiat
 *   - alerté Telegram si drifts > seuil (P1+)
 *
 * Querystring optionnels (clamp pour éviter abuse) :
 *   - limit (number, 1..500, défaut 100)
 *   - apps  (csv des apps à interroger, défaut toutes)
 *
 * Référence :
 *   - todo/2026-05-20-tenant-sync-strategy.md §"Niveau 3"
 *   - lib/sync/reconcile.ts
 *   - app/api/cron/cleanup-orphan-users/route.ts (pattern dry-run)
 */

import { NextRequest, NextResponse } from 'next/server';

import { sendTelegramAlert } from '@/lib/notifications/telegram';
import { runReconcile } from '@/lib/sync/reconcile';
import type { SyncApp } from '@/lib/sync/types';
import { SYNC_APPS } from '@/lib/sync/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min : marge pour 100 tenants × 4 apps × 2s

const CRON_SECRET = process.env.CRON_SECRET;
const ALERT_THRESHOLD = Number(process.env.RECONCILE_ALERT_THRESHOLD ?? 5);

function parseApps(raw: string | null): SyncApp[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is SyncApp => (SYNC_APPS as readonly string[]).includes(s));
  return list.length > 0 ? list : undefined;
}

function parseLimit(raw: string | null): number {
  const n = Number(raw ?? '100');
  if (!Number.isFinite(n) || n < 1) return 100;
  return Math.min(Math.max(Math.floor(n), 1), 500);
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  if (!CRON_SECRET) {
    console.error(
      JSON.stringify({
        tag: '[cron-reconcile-tenants]',
        level: 'error',
        message: 'CRON_SECRET not configured',
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json({ error: 'cron_not_configured' }, { status: 500 });
  }

  const auth = request.headers.get('authorization');
  const presented = auth?.replace(/^Bearer\s+/i, '');
  if (presented !== CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const apps = parseApps(url.searchParams.get('apps'));

  try {
    const summary = await runReconcile({ limit, apps });

    if (summary.driftsDetected >= ALERT_THRESHOLD) {
      await sendTelegramAlert(
        `<b>Reconcile tenants drift</b>\n` +
          `${summary.driftsDetected} drift(s) sur ${summary.usersScanned} tenants. ` +
          `${summary.appsUnreachable} apps unreachable.\n` +
          `Mode: ${summary.mode}.`,
      ).catch(() => undefined);
    }

    const httpDurationMs = Date.now() - startedAt;
    return NextResponse.json({ ok: true, ...summary, httpDurationMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron-reconcile-tenants] fatal:', msg);
    await sendTelegramAlert(
      `<b>Cron reconcile-tenants KO</b>\n${msg.slice(0, 500)}`,
    ).catch(() => undefined);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// GET pour observabilité (status sans auth, comme cleanup-trials).
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/cron/reconcile-tenants',
    method: 'POST',
    description:
      'Compare snapshot Hub vs apps downstream via discoverUserApps. Mode dry-run uniquement (P0).',
    authentication: 'Bearer CRON_SECRET',
    schedule: 'hourly (hub-reconcile-cron.yml)',
    querystring: {
      limit: 'number 1..500, default 100',
      apps: 'csv of notifuse|prospection|analytics|cms, default all',
    },
    references: [
      'todo/2026-05-20-tenant-sync-strategy.md §Niveau 3',
      'docs/CONTRAT-HUB.md §7 webhooks (Niveau 2)',
      'lib/sync/reconcile.ts',
    ],
  });
}
