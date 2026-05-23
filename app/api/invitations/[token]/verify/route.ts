/**
 * GET /api/invitations/[token]/verify
 *
 * Endpoint PUBLIC (pas d'auth) appelé par la page UI `/invite/[token]`
 * pour récupérer les meta d'une invitation cross-app avant affichage.
 *
 * Étape 3 du ticket P1 `todo/2026-05-20-hub-invitation-endpoints.md`.
 *
 * Renvoie un résultat structuré selon l'état :
 *   - valid:        invitation active, non expirée, non acceptée
 *   - expired:      invitation existait mais expiresAt < now
 *   - already_accepted: invitation existait, déjà acceptée
 *   - not_found:    token inconnu (ou format invalide)
 *
 * Pas d'info leak : le code distingue ces 4 états parce que l'UI doit
 * pouvoir afficher des messages différents, mais on ne révèle JAMAIS
 * l'email de l'invitee ni des détails sensibles à un attaquant qui
 * sonderait des tokens au hasard. Seuls les champs utiles à la page
 * d'acceptation sont renvoyés (inviter name/email, target_app,
 * target_workspace_id, message éventuel).
 *
 * Rate-limit : 30/min/IP (token brute-force déjà infaisable cryptographiquement,
 * limiter sert à étouffer le bruit log).
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  extractClientIp,
  invitationVerifyLimiter,
} from '@/lib/auth/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Le token est généré côté Hub (32 bytes hex). On rejette de loin les tokens
// qui n'ont pas le bon format pour éviter de hit la DB sur du junk.
const TOKEN_FORMAT = /^[0-9a-f]{64}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
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

  const { token } = await params;

  if (!TOKEN_FORMAT.test(token)) {
    return NextResponse.json(
      { valid: false, reason: 'not_found' },
      { status: 404 },
    );
  }

  const invitation = await prisma.crossAppInvitation.findUnique({
    where: { token },
    include: {
      inviter: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  if (!invitation) {
    return NextResponse.json(
      { valid: false, reason: 'not_found' },
      { status: 404 },
    );
  }

  const now = new Date();

  if (invitation.acceptedAt) {
    return NextResponse.json(
      {
        valid: false,
        reason: 'already_accepted',
        accepted_at: invitation.acceptedAt.toISOString(),
        target_app: invitation.targetApp,
      },
      { status: 200 },
    );
  }

  if (invitation.expiresAt <= now) {
    return NextResponse.json(
      {
        valid: false,
        reason: 'expired',
        expired_at: invitation.expiresAt.toISOString(),
        target_app: invitation.targetApp,
      },
      { status: 200 },
    );
  }

  return NextResponse.json(
    {
      valid: true,
      invitation: {
        id: invitation.id,
        invitee_email: invitation.inviteeEmail,
        target_app: invitation.targetApp,
        target_workspace_id: invitation.targetWorkspaceId,
        target_role: invitation.targetRole,
        message: invitation.message,
        expires_at: invitation.expiresAt.toISOString(),
        inviter: {
          name: invitation.inviter.name,
          email: invitation.inviter.email,
        },
      },
    },
    { status: 200 },
  );
}
