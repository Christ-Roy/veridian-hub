/**
 * POST /api/invitations/[token]/accept
 *
 * Endpoint utilisateur (session Hub requise) appelé par la page UI
 * `/invite/[token]` quand l'invitee clique "Accepter".
 *
 * Étape 4 du ticket P1 `todo/2026-05-20-hub-invitation-endpoints.md`.
 *
 * Comportement :
 *   - Session Hub requise (401 sinon)
 *   - Lookup + update atomique de l'invitation (transaction Prisma)
 *   - Marque acceptedAt + acceptedByUserId
 *   - **Phase 4b** : propage l'attach au workspace côté app downstream via
 *     `attachMemberDownstream` (HMAC). Status HTTP final dépend du résultat
 *     downstream :
 *       - `completed` → 200 OK + `redirect_url` = loginUrl (auto-login)
 *       - `pending`   → 202 Accepted + `redirect_url` = page d'accueil app
 *         (UI peut afficher "attribution en cours" + bouton retry)
 *       - `error`     → 502 Bad Gateway + `error` business code remonté
 *         (workspace_suspended, user_role_conflict, etc.)
 *   - Audit log écrit dans tous les cas (acceptation est ack côté Hub
 *     quel que soit l'issue downstream — l'invitation est consommée).
 *
 * Body optionnel :
 *   { allow_email_mismatch?: boolean }
 *   Permet d'accepter une invitation avec un email différent de
 *   `invitee_email`. UI affiche un warning et propose ce bouton.
 *
 * Rate-limit : 30/min/IP (même limiter que /verify — couvre les retries
 * et empêche le scan).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import {
  extractClientIp,
  invitationVerifyLimiter,
} from '@/lib/auth/rate-limit';
import { writeAuditLog } from '@/lib/admin/audit-log';
import {
  acceptCrossAppInvitation,
  buildPostAcceptRedirectUrl,
} from '@/lib/invitations/accept';
import { attachMemberDownstream } from '@/lib/invitations/attach-downstream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    allow_email_mismatch: z.boolean().optional(),
  })
  .optional();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = extractClientIp(request.headers);
  const rateResult = invitationVerifyLimiter.enforce(ip);
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

  const { token } = await params;

  let body: unknown = null;
  const rawBody = await request.text();
  if (rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }
  }
  const parsed = bodySchema.safeParse(body ?? undefined);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await acceptCrossAppInvitation(prisma, {
    token,
    acceptingUserId: user.id,
    acceptingUserEmail: user.email,
    allowEmailMismatch: parsed.data?.allow_email_mismatch === true,
    attachDownstream: attachMemberDownstream,
  });

  if (!result.ok) {
    const statusByCode: Record<typeof result.code, number> = {
      not_found: 404,
      invalid_token_format: 404,
      expired: 410, // Gone
      already_accepted: 409, // Conflict
      email_mismatch: 403,
    };
    return NextResponse.json(
      {
        error: result.code,
        ...(result.acceptedByUserId
          ? { accepted_by_user_id: result.acceptedByUserId }
          : {}),
      },
      { status: statusByCode[result.code] },
    );
  }

  await writeAuditLog(prisma, {
    action: 'invitation.cross_app.accept',
    actor: `user:${user.email}`,
    targetType: 'user',
    targetId: user.id,
    payload: {
      invitation_id: result.invitation.id,
      target_app: result.invitation.targetApp,
      target_workspace_id: result.invitation.targetWorkspaceId,
      target_role: result.invitation.targetRole,
      email_mismatch: result.emailMismatch,
      downstream_call: result.downstreamCall,
      downstream_http_status: result.downstreamHttpStatus ?? null,
      downstream_error_code: result.downstreamErrorCode ?? null,
    },
  });

  // Status HTTP final selon résultat downstream :
  //   - completed → 200 OK + redirect_url = loginUrl downstream (auto-login)
  //   - pending   → 202 Accepted + redirect_url = home page de l'app cible
  //                 (l'UI affiche "attribution en cours, ouvrez l'app dans
  //                 quelques secondes" + bouton retry).
  //   - error     → 502 Bad Gateway + error code business (workspace
  //                 suspended, role conflict). L'invitation reste consommée
  //                 côté Hub (audit) mais l'UI doit prévenir l'user.
  const fallbackRedirect = buildPostAcceptRedirectUrl(
    result.invitation.targetApp,
  );

  if (result.downstreamCall === 'completed') {
    return NextResponse.json(
      {
        ok: true,
        invitation_id: result.invitation.id,
        target_app: result.invitation.targetApp,
        target_workspace_id: result.invitation.targetWorkspaceId,
        target_role: result.invitation.targetRole,
        email_mismatch: result.emailMismatch,
        downstream_call: 'completed',
        // login_url retourné par downstream peut être null si l'app n'a pas
        // pu en générer (ex: tenant suspended) ; on retombe sur fallback.
        redirect_url: result.downstreamLoginUrl ?? fallbackRedirect,
      },
      { status: 200 },
    );
  }

  if (result.downstreamCall === 'error') {
    return NextResponse.json(
      {
        ok: false,
        invitation_id: result.invitation.id,
        target_app: result.invitation.targetApp,
        target_workspace_id: result.invitation.targetWorkspaceId,
        email_mismatch: result.emailMismatch,
        downstream_call: 'error',
        error: result.downstreamErrorCode ?? 'downstream_error',
        downstream_http_status: result.downstreamHttpStatus ?? null,
        // L'invitation est consommée côté Hub mais l'UI doit avertir.
        redirect_url: fallbackRedirect,
      },
      { status: 502 },
    );
  }

  // pending
  return NextResponse.json(
    {
      ok: true,
      invitation_id: result.invitation.id,
      target_app: result.invitation.targetApp,
      target_workspace_id: result.invitation.targetWorkspaceId,
      target_role: result.invitation.targetRole,
      email_mismatch: result.emailMismatch,
      downstream_call: 'pending',
      redirect_url: fallbackRedirect,
    },
    { status: 202 },
  );
}
