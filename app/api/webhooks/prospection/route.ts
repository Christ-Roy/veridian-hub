/**
 * Webhooks Prospection → Hub (contrat §7.1). Auth : `Authorization: Bearer <PROSPECTION_WEBHOOK_TOKEN>` (rotation : `_PREVIOUS`).
 * Corps : { event, tenant_id, data, idempotency_key, occurred_at, contract_version } ; dédup `hub_app.webhook_dedup` (app, idempotency_key), 24 h.
 *
 * Le Hub est la source (parente, 27/11). Les ÉCHOS d'ordres qu'il signe lui-même ne servent plus et ne doivent plus être émis :
 *   - `tenant.soft_deleted`, `tenant.purged` : l'état (`metadata.prospection_status` = `deleted`, `prospection_soft_deleted_at`,
 *     `prospection_purge_eligible_at`) est posé par `lib/apps/deprovision.ts` sur la réponse synchrone du soft-delete ;
 *   - `tenant.member_removed` : noté par `lib/tenants/membres.ts` (`retirer`) quand le retrait est relu chez Prospection ;
 *   - `tenant.member_added` : le Hub n'ajoute personne chez Prospection (seul écrivain des membres : lib/tenants/membres.ts) ; rien à recevoir.
 * Ces quatre échos ne sont d'ailleurs jamais arrivés (aucun planificateur ne vidait la file de Prospection depuis le 19/06).
 * La route reste servie tant que Prospection n'a pas coupé ses échos ; elle ne reçoit plus, à terme, que ce que seul Prospection sait
 * (`tenant.touched`, `tenant.quota_exceeded`, `tenant.activity_threshold_reached`, `tenant.member_role_changed`).
 * Gestionnaires : `lib/webhooks/prospection-handlers.ts`.
 */

import { NextRequest, NextResponse } from 'next/server';

import { handleWebhook } from '@/lib/webhooks/receiver';
import { prospectionHandlers } from '@/lib/webhooks/prospection-handlers';
import { readRotatingSecret } from '@/lib/webhooks/secret-rotation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // Double acceptation : `PROSPECTION_WEBHOOK_TOKEN` + éventuel
  // `PROSPECTION_WEBHOOK_TOKEN_PREVIOUS` pendant une fenêtre de rotation.
  const token = readRotatingSecret('PROSPECTION_WEBHOOK_TOKEN');
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
    handlers: prospectionHandlers,
  });
}
