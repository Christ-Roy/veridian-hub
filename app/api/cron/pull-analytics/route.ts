/**
 * Cron Job — Pull Analytics → events comportementaux prospect (réconciliateur).
 *
 * Endpoint  : POST /api/cron/pull-analytics
 * Schedule  : Toutes les heures (`.github/workflows/hub-pull-analytics-cron.yml`)
 * Auth      : header `Authorization: Bearer <CRON_SECRET>`
 *
 * Thin wrapper autour de `pullAnalytics` (auth Bearer + dispatch). Toute la
 * logique métier est dans `lib/prospect/analytics-pull.ts` pour permettre les
 * tests unitaires (Next.js App Router refuse les exports arbitraires).
 *
 * Ce que fait UN passage (porté du bridge `veridian-tunnel-de-vente`, doctrine
 * « clean et smart » Robert) : pull `export.userEvents` de l'engine Analytics
 * sur une fenêtre FIXE de 48 h → agrège par identité → ingère des events
 * comportementaux Hub (`page.hit` + jalons audit) via `ingestProspectEvent`.
 * Idempotence garantie par `idempotency_key` DÉTERMINISTE → re-pull complet =
 * 0 écriture (pas de curseur persistant). Le scoring est une couche AVAL
 * découplée (archi 2026-06-17) — ce cron ne fait QUE persister le flux d'events.
 *
 * Garde-fou : si `ENGINE_ADMIN_EMAIL`/`ENGINE_ADMIN_PASSWORD` sont absents, le
 * pull est skippé proprement (`skipped: true`, 200, 0 event) — même
 * comportement que le bridge.
 *
 * Référence :
 *   - lib/prospect/analytics-pull.ts
 *   - lib/prospect/ingest.ts (point d'entrée d'ingestion partagé)
 *   - app/api/cron/reconcile-tenants/route.ts (pattern thin wrapper)
 *   - docs/CONTRAT-HUB.md §7.5 (event comportemental uniforme)
 */

import { NextRequest, NextResponse } from 'next/server';

import { sendTelegramAlert } from '@/lib/notifications/telegram';
import { pullAnalytics, pullDepsFromEnv } from '@/lib/prospect/analytics-pull';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min : marge pour pagination export 48 h

const CRON_SECRET = process.env.CRON_SECRET;

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  if (!CRON_SECRET) {
    console.error(
      JSON.stringify({
        tag: '[cron-pull-analytics]',
        level: 'error',
        message: 'CRON_SECRET not configured',
        ts: new Date().toISOString()
      })
    );
    return NextResponse.json({ error: 'cron_not_configured' }, { status: 500 });
  }

  const auth = request.headers.get('authorization');
  const presented = auth?.replace(/^Bearer\s+/i, '');
  if (presented !== CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const summary = await pullAnalytics(pullDepsFromEnv());

    console.log(
      JSON.stringify({
        tag: '[cron-pull-analytics]',
        level: 'info',
        ...summary
      })
    );

    const httpDurationMs = Date.now() - startedAt;
    return NextResponse.json({ ok: true, ...summary, httpDurationMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron-pull-analytics] fatal:', msg);
    await sendTelegramAlert(
      `<b>Cron pull-analytics KO</b>\n${msg.slice(0, 500)}`
    ).catch(() => undefined);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// GET pour observabilité (status sans auth, comme reconcile-tenants).
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/cron/pull-analytics',
    method: 'POST',
    description:
      'Pull export.userEvents (fenêtre 48 h) → agrège par identité → ingère page.hit + jalons audit via ingestProspectEvent. Idempotent (idempotency_key déterministe).',
    authentication: 'Bearer CRON_SECRET',
    schedule: 'hourly (hub-pull-analytics-cron.yml)',
    references: [
      'lib/prospect/analytics-pull.ts',
      'lib/prospect/ingest.ts',
      'docs/CONTRAT-HUB.md §7.5'
    ]
  });
}
