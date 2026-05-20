/**
 * POST /api/admin/users/create
 *
 * Crée un user Hub sans attendre signup OAuth (mode service).
 * Idempotent : si l'email existe déjà, retourne le user existant.
 *
 * Auth : `requireAdmin` (session admin ou x-admin-secret).
 * Validation : Zod sur le body.
 * Audit : row `audit_log` action='admin.user.create' actor=<resolved>.
 *
 * Pattern d'usage type (skill agent IA) :
 *   curl -X POST https://app.veridian.site/api/admin/users/create \
 *     -H "x-admin-secret: $ADMIN_SECRET" \
 *     -d '{"email":"client@x.com","name":"Didier"}'
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import { upsertHubUser } from '@/lib/admin/users';
import { writeAuditLog, resolveActor } from '@/lib/admin/audit-log';
import { authenticateAdmin } from '@/lib/admin/authenticate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z.string().email(),
  // name affiché dans le dashboard, exports CSV, emails. React échappe par
  // défaut mais on bloque quand même les chars contrôle et < > pour les
  // downstream (CSV injection via =, +, -, @ → mitigé séparément côté export).
  name: z
    .string()
    .min(1)
    .max(120)
    .refine((s) => !/[\x00-\x1f<>]/.test(s), {
      message: 'name: no control characters or < >',
    })
    .optional(),
  supabaseUserId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: NextRequest) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const result = await upsertHubUser(prisma, parsed.data);
  const actor = resolveActor(request.headers, authResult.sessionEmail);

  await writeAuditLog(prisma, {
    action: 'admin.user.create',
    actor,
    targetType: 'user',
    targetId: result.userId,
    payload: {
      email: result.email,
      already_existed: result.alreadyExisted,
      metadata: parsed.data.metadata,
    },
  });

  return NextResponse.json({
    user_id: result.userId,
    supabase_user_id: result.supabaseUserId,
    email: result.email,
    created: result.created,
    already_existed: result.alreadyExisted,
  });
}
