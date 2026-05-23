/**
 * POST /api/invitations/revoke/[id]
 *
 * Permet à l'inviter de révoquer une invitation pending qu'il a créée.
 * Étape 6 du ticket P1 `todo/2026-05-20-hub-invitation-endpoints.md`.
 *
 * Pourquoi POST et pas DELETE (alors que le ticket dit DELETE) :
 *   - Routing Next App Router : `/invitations/[id]` collisionne avec
 *     `/invitations/create` (le segment `create` est interprété comme `[id]`).
 *   - Mettre la route sous un sous-segment `revoke/[id]` évite la collision
 *     ET rend l'intention explicite. POST est sémantiquement correct car
 *     on ne supprime pas vraiment (on expire la row pour garder l'audit).
 *
 * Comportement :
 *   - Session Hub requise (401 sinon)
 *   - 403 si l'inviter ≠ session.user (ne pas révoquer une invitation
 *     créée par quelqu'un d'autre)
 *   - 409 si l'invitation a déjà été acceptée (état non-révocable)
 *   - 404 si l'invitation est inconnue
 *   - 200 ok+already_inactive=true|false si succès (no-op si déjà expirée)
 *
 * Pas de vraie DELETE SQL — on force `expiresAt = now` pour garder la row
 * en DB (audit forensics, traçabilité multi-révocation).
 *
 * Rate-limit : 30/min/IP (même limiter que /verify et /accept).
 */

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import {
  extractClientIp,
  invitationVerifyLimiter,
} from '@/lib/auth/rate-limit';
import { writeAuditLog } from '@/lib/admin/audit-log';
import { revokeCrossAppInvitation } from '@/lib/invitations/revoke';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Id Prisma cuid format : ^c[a-z0-9]{24}$ — on est moins strict ici parce
// que les cuid Prisma changent parfois, on s'en tient à un sanity check
// (pas d'injection de path traversal, longueur raisonnable).
const ID_FORMAT = /^[a-zA-Z0-9_-]{1,64}$/;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ip = extractClientIp(request.headers);
  // enforceWithBypass : bypass E2E staging via header secret valide
  // (cf. lib/auth/rate-limit.ts). En prod le bypass est ignoré.
  const rateResult = invitationVerifyLimiter.enforceWithBypass(
    ip,
    request.headers,
  );
  if (!rateResult.ok) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(rateResult.retryAfterSeconds) },
      },
    );
  }

  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.email) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!ID_FORMAT.test(id)) {
    return NextResponse.json(
      { error: 'invalid_id_format' },
      { status: 400 },
    );
  }

  const result = await revokeCrossAppInvitation(prisma, {
    invitationId: id,
    expectedInviterUserId: user.id,
  });

  if (!result.ok) {
    const status =
      result.code === 'not_found'
        ? 404
        : result.code === 'forbidden'
          ? 403
          : 409;
    return NextResponse.json({ error: result.code }, { status });
  }

  await writeAuditLog(prisma, {
    action: result.alreadyInactive
      ? 'invitation.cross_app.revoke.noop'
      : 'invitation.cross_app.revoke',
    actor: `user:${user.email}`,
    targetType: 'user',
    targetId: user.id,
    payload: {
      invitation_id: result.invitation.id,
      invitee_email: result.invitation.inviteeEmail,
      target_app: result.invitation.targetApp,
      target_workspace_id: result.invitation.targetWorkspaceId,
      already_inactive: result.alreadyInactive,
    },
  });

  return NextResponse.json(
    {
      ok: true,
      invitation_id: result.invitation.id,
      already_inactive: result.alreadyInactive,
      expires_at: result.invitation.expiresAt.toISOString(),
    },
    { status: 200 },
  );
}
