/**
 * Cron Job — Drift detection `tenant_trials` vs Stripe subscriptions.
 *
 * Endpoint  : POST /api/cron/trial-drift-detection
 * Schedule  : Quotidien 07:00 UTC (`.github/workflows/hub-trial-drift-cron.yml`)
 * Auth      : header `Authorization: Bearer <CRON_SECRET>`
 *
 * Thin wrapper auth Bearer + dispatch vers `detectTrialSubDrifts`. Toute la
 * logique métier est dans `lib/trial/drift-detection.ts` pour rester testable
 * unitairement (Next.js App Router refuse les exports arbitraires).
 *
 * MODE REPORT-ONLY ONLY (v1). Aucune écriture côté Hub ni Stripe. Le résultat
 * est :
 *   - logué (Grafana Loki via console.warn structuré si drifts > 0)
 *   - renvoyé en JSON pour audit immédiat (le workflow GH Actions parse le
 *     code retour pour notifier en rouge dans l'onglet Actions si drifts > 0)
 *
 * Querystring optionnels (clamp pour éviter abuse) :
 *   - chunkSize (number, 1..500, défaut 100)
 *   - limit     (number, 1..100000, défaut illimité)
 *
 * Référence :
 *   - todo/2026-05-24-drift-detection-trial-vs-sub.md
 *   - lib/trial/drift-detection.ts
 *   - app/api/cron/reconcile-tenants/route.ts (pattern miroir)
 */

import { NextRequest, NextResponse } from 'next/server';

import { detectTrialSubDrifts } from '@/lib/trial/drift-detection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 8 min : marge large pour quelques milliers de rows × call Stripe sériel.
export const maxDuration = 480;

const CRON_SECRET = process.env.CRON_SECRET;

function parseChunkSize(raw: string | null): number {
  const n = Number(raw ?? '100');
  if (!Number.isFinite(n) || n < 1) return 100;
  return Math.min(Math.max(Math.floor(n), 1), 500);
}

function parseLimit(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(Math.max(Math.floor(n), 1), 100_000);
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  if (!CRON_SECRET) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        tag: '[cron-trial-drift]',
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
  const chunkSize = parseChunkSize(url.searchParams.get('chunkSize'));
  const limit = parseLimit(url.searchParams.get('limit'));

  try {
    const summary = await detectTrialSubDrifts({ chunkSize, limit });
    const httpDurationMs = Date.now() - startedAt;
    return NextResponse.json({
      ok: true,
      summary: {
        totalScanned: summary.totalScanned,
        skippedNoStripeCustomer: summary.skippedNoStripeCustomer,
        stripeErrors: summary.stripeErrors,
        driftsDetected: summary.driftsDetected,
        mode: summary.mode,
        startedAt: summary.startedAt,
        durationMs: summary.durationMs,
        errors: summary.errors,
      },
      drifts: summary.drifts,
      httpDurationMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        tag: '[cron-trial-drift]',
        level: 'error',
        message: 'fatal',
        error: msg,
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// GET pour observabilité (status sans auth, comme reconcile-tenants).
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/cron/trial-drift-detection',
    method: 'POST',
    description:
      'Detect drifts between hub_app.tenant_trials and Stripe subscriptions. Mode report-only only (v1, P0 lock).',
    authentication: 'Bearer CRON_SECRET',
    schedule: 'daily 07:00 UTC (hub-trial-drift-cron.yml)',
    querystring: {
      chunkSize: 'number 1..500, default 100',
      limit: 'number 1..100000, default unlimited',
    },
    references: [
      'todo/2026-05-24-drift-detection-trial-vs-sub.md',
      'docs/AUDIT-TRIAL-RESIDUS-2026-05-24.md §3.3',
      'lib/trial/drift-detection.ts',
    ],
  });
}
