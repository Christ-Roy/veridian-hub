/**
 * POST /api/mail/send-as-user
 *
 * Route HMAC entrante du Mail Gateway v1 (Gmail-only).
 *
 * Consommée par les apps downstream (Notifuse, Prospection, CMS, Analytics)
 * pour envoyer un mail au nom de l'utilisateur via son Gmail connecté.
 *
 * Voir spec complète : `docs/CONTRAT-MAIL.md` v1.0.
 *
 * Auth : HMAC Pattern A (`<APP>_HUB_API_SECRET`) — voir
 * `lib/mail/send-as-user-hmac.ts`.
 *
 * Réponses :
 *   200 { message_id, provider_used, sent_at, idempotent_replay? }
 *   400 invalid_payload | invalid_json | missing headers
 *   401 invalid_hmac (signature / drift)
 *   404 user_not_found (user_id inconnu côté Hub)
 *   412 needs_reauth (refresh_token révoqué)
 *   422 provider_not_linked (user n'a pas connecté son Gmail)
 *   429 rate_limit
 *   503 provider_unreachable | secret_not_configured
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  extractClientIp,
  mailSendAsUserLimiter,
  mailSendAsUserPreVerifyLimiter,
} from '@/lib/auth/rate-limit';
import {
  verifySendAsUserHmac,
  type SupportedApp,
} from '@/lib/mail/send-as-user-hmac';
import {
  sendGmailAsUser,
  MailUserNotFoundError,
  MailProviderNotLinkedError,
  MailNeedsReauthError,
  MailProviderUnreachableError,
} from '@/lib/mail/send-gmail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const attachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content_base64: z.string().min(1),
  mime_type: z.string().min(1).max(127),
});

const bodySchema = z
  .object({
    user_id: z.string().min(1).max(64),
    to: z.union([
      z.string().email(),
      z.array(z.string().email()).min(1).max(50),
    ]),
    subject: z.string().min(1).max(998),
    body_text: z.string().max(1_048_576).optional(),
    body_html: z.string().max(2_097_152).optional(),
    cc: z.array(z.string().email()).max(50).optional(),
    bcc: z.array(z.string().email()).max(50).optional(),
    reply_to: z.string().email().optional(),
    attachments: z.array(attachmentSchema).max(10).optional(),
    /** Provider choice — en v1 seul `google` ou `auto` est résolu. */
    provider: z.enum(['google', 'microsoft', 'auto']).optional(),
    idempotency_key: z.string().uuid(),
    contract_version: z.literal('1.0'),
  })
  .refine((d) => d.body_text || d.body_html, {
    message: 'Either body_text or body_html is required',
    path: ['body_text'],
  });

function jsonError(
  code: string,
  status: number,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: code, ...extra }, { status });
}

export async function POST(request: NextRequest) {
  // ─── Pre-verify rate-limit (IP) — anti-flood avant HMAC CPU ──────────
  const ip = extractClientIp(request.headers);
  const preRate = mailSendAsUserPreVerifyLimiter.enforceWithBypass(
    ip,
    request.headers,
  );
  if (!preRate.ok) {
    return jsonError(
      'rate_limit',
      429,
      { retry_after: preRate.retryAfterSeconds },
    );
  }

  // ─── HMAC verify ──────────────────────────────────────────────────────
  const rawBody = await request.text();
  const hmac = verifySendAsUserHmac(request.headers, rawBody);
  if (!hmac.ok) {
    const code = hmac.status === 503 ? 'secret_not_configured' : 'invalid_hmac';
    return jsonError(code, hmac.status, { reason: hmac.reason });
  }
  const app: SupportedApp = hmac.app;

  // ─── Parse body ───────────────────────────────────────────────────────
  let json: unknown;
  try {
    json = rawBody.length === 0 ? null : JSON.parse(rawBody);
  } catch {
    return jsonError('invalid_json', 400);
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return jsonError('invalid_payload', 400, {
      issues: parsed.error.issues,
    });
  }

  // En v1, seul Gmail est supporté. Si l'app demande microsoft → 422.
  if (parsed.data.provider === 'microsoft') {
    return jsonError('provider_not_supported_v1', 422, {
      message: 'Microsoft Mail Sender will be supported in v2 (cf docs/CONTRAT-MAIL.md)',
    });
  }

  // ─── Post-HMAC rate-limit (app:user_id) ──────────────────────────────
  const userRateKey = `${app}:${parsed.data.user_id}`;
  const userRate = mailSendAsUserLimiter.enforceWithBypass(
    userRateKey,
    request.headers,
  );
  if (!userRate.ok) {
    return jsonError(
      'rate_limit',
      429,
      { retry_after: userRate.retryAfterSeconds },
    );
  }

  // ─── Send via broker ─────────────────────────────────────────────────
  try {
    const result = await sendGmailAsUser(parsed.data.user_id, {
      to: parsed.data.to,
      subject: parsed.data.subject,
      body_text: parsed.data.body_text,
      body_html: parsed.data.body_html,
      cc: parsed.data.cc,
      bcc: parsed.data.bcc,
      reply_to: parsed.data.reply_to,
      attachments: parsed.data.attachments,
      appSource: app,
      idempotencyKey: parsed.data.idempotency_key,
    });

    return NextResponse.json({
      message_id: result.messageId,
      provider_used: 'google',
      sent_at: result.sentAt.toISOString(),
      idempotent_replay: result.idempotentReplay ?? false,
    });
  } catch (err) {
    if (err instanceof MailUserNotFoundError) {
      return jsonError('user_not_found', err.status);
    }
    if (err instanceof MailProviderNotLinkedError) {
      return jsonError('provider_not_linked', err.status);
    }
    if (err instanceof MailNeedsReauthError) {
      return jsonError('needs_reauth', err.status);
    }
    if (err instanceof MailProviderUnreachableError) {
      return jsonError('provider_unreachable', err.status, {
        message: err.message,
      });
    }
    console.error(
      JSON.stringify({
        tag: '[mail-send-as-user]',
        level: 'error',
        msg: 'unexpected_error',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
    return jsonError('internal_error', 500);
  }
}
