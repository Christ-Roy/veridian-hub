/**
 * POST /api/invitations/create
 *
 * Endpoint machine-to-machine appelé par une app downstream (Notifuse,
 * Prospection, Analytics, CMS) pour créer une invitation cross-app gérée
 * par le Hub. Étape 2 du ticket P1
 * `todo/2026-05-20-hub-invitation-endpoints.md`.
 *
 * Auth :   HMAC sha256 — header `x-veridian-invitation-signature`,
 *          secret partagé `HUB_INVITATION_SECRET_<APP>`.
 * Rate :   60 req/min/IP (anti-flood, large pour onboarding batch).
 * Body :   { inviter_user_id, inviter_email, invitee_email,
 *            target_app, target_workspace_id, target_role?, message? }
 * Response: { invitation_id, token, magic_link_url, expires_at, reused }
 *
 * Idempotence : si une invitation pending existe pour le couple
 * (invitee_email, target_app, target_workspace_id), on retourne l'existante
 * (reused=true) au lieu d'en créer une nouvelle. L'app downstream n'a pas
 * à gérer ce cas — elle re-call et reçoit la même magic_link_url.
 *
 * L'envoi du magic link par email est piloté par l'app caller (qui peut
 * vouloir contrôler ses propres templates) OU sera ajouté en étape 7 du
 * ticket (template MJML via Notifuse).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/prisma';
import {
  extractClientIp,
  invitationCreateLimiter,
} from '@/lib/auth/rate-limit';
import { writeAuditLog } from '@/lib/admin/audit-log';
import {
  buildMagicLinkUrl,
  createCrossAppInvitation,
  InvitationCreateError,
} from '@/lib/invitations/create';
import { verifyInvitationHmac } from '@/lib/invitations/hmac';
import { sendMail } from '@/lib/email/send';
import { buildCrossAppInvitationEmail } from '@/lib/email/templates/cross-app-invitation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  inviter_user_id: z.string().min(1).max(64),
  inviter_email: z.string().email().max(254),
  invitee_email: z.string().email().max(254),
  target_app: z.enum(['notifuse', 'prospection', 'analytics', 'cms']),
  target_workspace_id: z.string().min(1).max(128),
  target_role: z.enum(['owner', 'admin', 'member']).optional(),
  // Message libre affiché dans la page /invite/[token] et l'email d'invitation.
  // Bloque chars contrôle + < > pour XSS (la page React échappe par défaut
  // mais on durcit en couches).
  message: z
    .string()
    .max(500)
    .refine((s) => !/[\x00-\x1f<>]/.test(s), {
      message: 'message: no control characters or < >',
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  const ip = extractClientIp(request.headers);
  // enforceWithBypass : bypass E2E staging via header secret valide
  // (cf. lib/auth/rate-limit.ts). En prod le bypass est ignoré par
  // `shouldBypassRateLimit` → comportement identique au legacy `enforce(ip)`.
  const rateResult = invitationCreateLimiter.enforceWithBypass(
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

  // HMAC verify exige le rawBody (bytes exacts signés), pas le JSON.parse.
  const rawBody = await request.text();
  const hmac = verifyInvitationHmac(request.headers, rawBody);
  if (!hmac.ok) {
    return NextResponse.json(
      { error: 'unauthorized', reason: hmac.reason },
      { status: hmac.status },
    );
  }

  let json: unknown;
  try {
    json = rawBody.length === 0 ? null : JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Cohérence anti-spoofing : x-veridian-app (utilisé pour le secret HMAC)
  // doit matcher body.target_app. Sinon une app compromise pourrait créer
  // des invitations pour le compte d'autres apps.
  if (parsed.data.target_app !== hmac.app) {
    return NextResponse.json(
      {
        error: 'app_mismatch',
        reason: `x-veridian-app=${hmac.app} but target_app=${parsed.data.target_app}`,
      },
      { status: 403 },
    );
  }

  try {
    const result = await createCrossAppInvitation(prisma, {
      inviterUserId: parsed.data.inviter_user_id,
      inviterEmail: parsed.data.inviter_email,
      inviteeEmail: parsed.data.invitee_email,
      targetApp: parsed.data.target_app,
      targetWorkspaceId: parsed.data.target_workspace_id,
      targetRole: parsed.data.target_role,
      message: parsed.data.message,
    });

    const magicLinkUrl = buildMagicLinkUrl(result.invitation.token);

    await writeAuditLog(prisma, {
      action: result.reused
        ? 'invitation.cross_app.create.reused'
        : 'invitation.cross_app.create',
      actor: `app:${hmac.app}`,
      targetType: 'user',
      targetId: parsed.data.inviter_user_id,
      payload: {
        invitation_id: result.invitation.id,
        invitee_email: parsed.data.invitee_email,
        target_app: parsed.data.target_app,
        target_workspace_id: parsed.data.target_workspace_id,
        target_role: result.invitation.targetRole,
        reused: result.reused,
      },
    });

    // Envoi email d'invitation cross-app (livrable 4 sprint v1.4).
    // Best-effort : si l'envoi échoue, on garde l'invitation en DB —
    // l'app caller peut renvoyer manuellement via le magic_link_url
    // retourné dans la réponse. On loggue l'échec pour observabilité.
    // Sur idempotence (reused=true) on RE-envoie l'email : l'app
    // downstream re-poke "Inviter" = l'inviteur veut un nouveau rappel.
    try {
      const inviterDisplayName =
        parsed.data.inviter_email.split('@')[0] || parsed.data.inviter_email;
      const email = buildCrossAppInvitationEmail({
        inviterName: inviterDisplayName,
        inviterEmail: parsed.data.inviter_email,
        inviteeEmail: parsed.data.invitee_email,
        targetApp: parsed.data.target_app,
        targetRole: result.invitation.targetRole,
        inviteUrl: magicLinkUrl,
        expiresAt: result.invitation.expiresAt,
        message: parsed.data.message,
      });
      await sendMail({
        to: parsed.data.invitee_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
    } catch (mailErr) {
      console.error(
        JSON.stringify({
          tag: '[invitations][create][email][error]',
          level: 'warn',
          invitation_id: result.invitation.id,
          target_app: parsed.data.target_app,
          error: mailErr instanceof Error ? mailErr.message : String(mailErr),
          ts: new Date().toISOString(),
        }),
      );
      // On ne fail PAS la requête : l'invitation est créée, le magic_link
      // est retourné, l'app caller peut afficher / renvoyer manuellement.
    }

    return NextResponse.json(
      {
        invitation_id: result.invitation.id,
        token: result.invitation.token,
        magic_link_url: magicLinkUrl,
        expires_at: result.invitation.expiresAt.toISOString(),
        target_role: result.invitation.targetRole,
        reused: result.reused,
      },
      { status: result.reused ? 200 : 201 },
    );
  } catch (err) {
    if (err instanceof InvitationCreateError) {
      const status =
        err.code === 'inviter_not_found'
          ? 404
          : err.code === 'self_invitation'
            ? 422
            : 400;
      return NextResponse.json(
        { error: err.code, reason: err.message },
        { status },
      );
    }
    console.error(
      JSON.stringify({
        tag: '[invitations][create][error]',
        level: 'error',
        error: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
