/**
 * Webhooks Prospection → Hub (contrat v1.4 §7.1).
 *
 * Auth : `Authorization: Bearer <PROSPECTION_WEBHOOK_TOKEN>`
 * Body : { event, tenant_id, data, idempotency_key, occurred_at,
 *          contract_version }
 *
 * Dédup : `hub_app.webhook_dedup` PK (app, idempotency_key) — fenêtre 24h.
 *
 * Events couverts (stubs initialement — la persistence du payload dans la
 * table webhook_dedup suffit pour audit, les effets de bord seront branchés
 * au fur et à mesure que les apps émettent réellement) :
 *
 *   - tenant.touched                    — user actif sur tenant soft_deleted
 *   - tenant.member_role_changed        — admin Prospection change rôle local
 *   - tenant.activity_threshold_reached — signal anti-churn / cleanup
 *   - tenant.suspended / tenant.resumed — admin Prospection (futur)
 *
 * Référence : `docs/CONTRAT-HUB-API-REF.md` section "Webhooks app → Hub".
 */

import { NextRequest, NextResponse } from 'next/server';

import { handleWebhook, type HandlerTable } from '@/lib/webhooks/receiver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handlers: HandlerTable = {
  'tenant.touched': async (payload) => {
    console.info(
      '[webhook:prospection] tenant.touched',
      payload.tenant_id,
      payload.data,
    );
  },
  'tenant.member_role_changed': async (payload) => {
    console.info(
      '[webhook:prospection] tenant.member_role_changed',
      payload.tenant_id,
      payload.data,
    );
  },
  'tenant.activity_threshold_reached': async (payload) => {
    console.info(
      '[webhook:prospection] tenant.activity_threshold_reached',
      payload.tenant_id,
      payload.data,
    );
  },
};

export async function POST(request: NextRequest) {
  const token = process.env.PROSPECTION_WEBHOOK_TOKEN;
  if (!token) {
    return NextResponse.json(
      {
        error: 'internal_error',
        message: 'PROSPECTION_WEBHOOK_TOKEN not configured',
      },
      { status: 500 },
    );
  }
  return handleWebhook(request, {
    app: 'prospection',
    expectedToken: token,
    handlers,
  });
}
