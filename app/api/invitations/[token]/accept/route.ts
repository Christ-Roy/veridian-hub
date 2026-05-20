/**
 * POST /api/invitations/[token]/accept
 *
 * Endpoint utilisateur (session Hub requise) appelé par la page UI
 * `/invite/[token]` quand l'invitee clique "Accepter".
 *
 * Étape 4a du ticket P1 `todo/2026-05-20-hub-invitation-endpoints.md`.
 *
 * Comportement livré (4a) :
 *   - Session Hub requise (401 sinon)
 *   - Lookup + update atomique de l'invitation (transaction Prisma)
 *   - Marque acceptedAt + acceptedByUserId
 *   - Renvoie 202 Accepted (action enregistrée côté Hub mais propagation
 *     vers l'app downstream non encore livrée)
 *   - Audit log
 *
 * Comportement NON encore livré (4b — à câbler quand les apps downstream
 * exposent un endpoint `attach-member`) :
 *   - Appel HMAC vers l'app cible pour ajouter le user au workspace
 *   - Génération du magic-link auto-login vers l'app downstream
 *   - Réponse 200 OK avec `redirect_url` finale
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
    },
  });

  const redirectUrl = buildPostAcceptRedirectUrl(result.invitation.targetApp);

  // 202 Accepted : Hub a enregistré l'acceptation mais la propagation vers
  // l'app downstream est encore "pending" (phase 4b). Le client UI peut
  // rediriger vers `redirect_url` (page d'accueil de l'app cible) — le user
  // verra qu'il n'est pas encore ajouté au workspace tant que phase 4b pas
  // livrée. Statut 200 réservé pour quand le downstream call sera complet.
  return NextResponse.json(
    {
      ok: true,
      invitation_id: result.invitation.id,
      target_app: result.invitation.targetApp,
      target_workspace_id: result.invitation.targetWorkspaceId,
      target_role: result.invitation.targetRole,
      email_mismatch: result.emailMismatch,
      downstream_call: result.downstreamCall,
      redirect_url: redirectUrl,
    },
    { status: 202 },
  );
}
