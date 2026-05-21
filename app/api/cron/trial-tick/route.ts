/**
 * Cron Job: Trial state machine tick.
 *
 * Endpoint  : POST /api/cron/trial-tick
 * Schedule  : Toutes les 30 minutes (`.github/workflows/hub-trial-tick-cron.yml`)
 * Auth      : header `Authorization: Bearer <CRON_SECRET>`
 *
 * Cette route est un thin wrapper autour de `runTrialTick` qui vit dans
 * `lib/trial/run-tick.ts` — Next.js App Router refuse les exports
 * arbitraires depuis un route file (seuls `runtime/dynamic/maxDuration/etc.`
 * sont valides), donc toute logique testable est extraite.
 *
 * Référence : `todo/2026-05-21-trial-state-machine.md`,
 *             `docs/PRICING-VERIDIAN.md` §"Flow trial complet",
 *             `docs/CONTRAT-HUB.md` §"Trial state machine".
 */

import { NextRequest, NextResponse } from 'next/server';

import { sendTelegramAlert } from '@/lib/notifications/telegram';
import { runTrialTick } from '@/lib/trial/run-tick';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min : marge pour batches > 100 trials

const CRON_SECRET = process.env.CRON_SECRET;

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  if (!CRON_SECRET) {
    console.error(
      JSON.stringify({
        tag: '[cron-trial-tick]',
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

  try {
    const summary = await runTrialTick();
    const durationMs = Date.now() - startedAt;
    console.log(
      JSON.stringify({
        tag: '[cron-trial-tick]',
        level: 'info',
        durationMs,
        ...summary,
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json({ ok: true, durationMs, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron-trial-tick] fatal:', msg);
    await sendTelegramAlert(
      `<b>Cron trial-tick KO</b>\n${msg.slice(0, 500)}`,
    ).catch(() => undefined);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// GET pour observabilité (status sans auth, comme cleanup-trials).
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/cron/trial-tick',
    method: 'POST',
    description:
      'Avance la trial state machine cross-app : activate (J+2), notify (J+12), finalize (J+15).',
    authentication: 'Bearer CRON_SECRET',
    schedule: 'every 30 minutes (hub-trial-tick-cron.yml)',
    references: [
      'docs/PRICING-VERIDIAN.md §Flow trial complet',
      'docs/CONTRAT-HUB.md §Trial state machine',
      'todo/2026-05-21-trial-state-machine.md',
    ],
  });
}
