/**
 * Cron Job — Push prospect scores → CRM (réconciliateur, couche AVAL découplée).
 *
 * Endpoint  : POST /api/cron/push-prospect-scores
 * Schedule  : Toutes les heures (`.github/workflows/hub-push-scores-cron.yml`)
 * Auth      : header `Authorization: Bearer <CRON_SECRET>`
 *
 * Thin wrapper autour de `pushProspectScores` (auth Bearer + dispatch). Toute la
 * logique métier est dans `lib/prospect/push-to-crm.ts` pour permettre les tests
 * unitaires (Next.js App Router refuse les exports arbitraires).
 *
 * Ce que fait UN passage (archi events ⟂ scoring DÉCOUPLÉS, Robert 2026-06-17) :
 * pour chaque prospect ayant des events, RELIT ses events agrégés → RECALCULE le
 * score FROM-SCRATCH via un `ScoringEngine` pluggable → ÉCRIT le score en DB →
 * ROUTE multitenant (tenant_uuid → CrmTenant) → PUSHE au CRM (resolve Person →
 * timeline → score → doNotContact → opportunity NEW→SCREENING). Idempotence
 * SORTANTE : re-push uniquement si le score a changé (`crm_pushed_score`).
 *
 * DRY_RUN par défaut (phase bascule) : `CRON_PUSH_DRY_RUN` (défaut true) →
 * mutations Twenty LOGUÉES, pas envoyées. 0 CrmTenant en prod au 2026-06-17 →
 * les prospects sont scorés en DB mais le push est skippé gracieusement.
 *
 * Référence :
 *   - lib/prospect/push-to-crm.ts (logique orchestratrice)
 *   - lib/prospect/scoring.ts (moteur pluggable, recompute from-scratch)
 *   - lib/crm/client.ts (écriture Twenty par tenant, DRY_RUN, token bucket)
 *   - app/api/cron/pull-analytics/route.ts (pattern thin wrapper)
 */

import { NextRequest, NextResponse } from 'next/server';

import { sendTelegramAlert } from '@/lib/notifications/telegram';
import { pushDepsFromEnv, pushProspectScores } from '@/lib/prospect/push-to-crm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min : marge pour N prospects × push CRM séquentiel

const CRON_SECRET = process.env.CRON_SECRET;

function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(Math.max(Math.floor(n), 1), 500);
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  if (!CRON_SECRET) {
    console.error(
      JSON.stringify({
        tag: '[cron-push-prospect-scores]',
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

  try {
    const summary = await pushProspectScores({ ...pushDepsFromEnv(), limit });

    console.log(
      JSON.stringify({
        tag: '[cron-push-prospect-scores]',
        level: 'info',
        ...summary,
      }),
    );

    const httpDurationMs = Date.now() - startedAt;
    return NextResponse.json({ ok: true, ...summary, httpDurationMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron-push-prospect-scores] fatal:', msg);
    await sendTelegramAlert(
      `<b>Cron push-prospect-scores KO</b>\n${msg.slice(0, 500)}`,
    ).catch(() => undefined);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// GET pour observabilité (status sans auth, comme pull-analytics).
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/cron/push-prospect-scores',
    method: 'POST',
    description:
      'Relit les events agrégés par prospect → recalcule le score (engine pluggable) → écrit prospect_scores → route multitenant → pushe au CRM. Idempotence sortante (crm_pushed_score). DRY_RUN par défaut (CRON_PUSH_DRY_RUN).',
    authentication: 'Bearer CRON_SECRET',
    schedule: 'hourly (hub-push-scores-cron.yml)',
    querystring: {
      limit: 'number 1..500, default 500',
    },
    references: [
      'lib/prospect/push-to-crm.ts',
      'lib/prospect/scoring.ts',
      'lib/crm/client.ts',
      'docs/CONTRAT-HUB.md §7.5',
    ],
  });
}
