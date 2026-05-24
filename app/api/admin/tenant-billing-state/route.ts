/**
 * POST /api/admin/tenant-billing-state
 *
 * Wrapper admin (session-based) du lib `getBillingState(tenantId, app)`.
 * Permet à l'UI admin `/dashboard/admin/lookup` d'afficher l'état billing
 * live d'un tenant sans passer par la route HMAC `/api/tenants/:id/billing-state`
 * (réservée aux apps downstream).
 *
 * Auth : `authenticateAdmin` (session + rate-limit).
 *
 * Body : `{ tenantId: uuid, app: 'notifuse' | 'prospection' }`
 * Response 200 : `{ ok: true, response: BillingStateResponse, cached: boolean }`
 * Response 4xx : `{ error, details? }`
 *
 * Read-only. Pas d'audit log.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticateAdmin } from '@/lib/admin/authenticate';
import { getBillingState } from '@/lib/billing/billing-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  tenantId: z.string().uuid({ message: 'tenantId must be a UUID' }),
  app: z.enum(['notifuse', 'prospection']),
});

export async function POST(request: NextRequest) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { tenantId, app } = parsed.data;
  const result = await getBillingState(tenantId, app);

  if (!result.ok) {
    const status = result.error.code === 'tenant_not_found' ? 404 : 500;
    return NextResponse.json({ error: result.error.code, details: 'details' in result.error ? result.error.details : undefined }, { status });
  }

  return NextResponse.json({
    ok: true,
    response: result.response,
    cached: result.cached,
  });
}
