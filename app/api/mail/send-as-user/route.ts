/**
 * POST /api/mail/send-as-user
 *
 * Route HMAC entrante du Mail Gateway (Gmail-only). v1.0 + v1.1.
 *
 * Consommée par les apps downstream (Notifuse, Prospection, CMS, Analytics)
 * pour envoyer un mail au nom de l'utilisateur via son Gmail connecté.
 *
 * Voir spec complète : `docs/CONTRAT-MAIL.md` v1.0 + ticket v1.1
 * `todo/2026-05-25-mail-provider-status-endpoint.md` §3 + §4.
 *
 * Auth : HMAC Pattern A (`<APP>_HUB_API_SECRET`) — voir
 * `lib/mail/send-as-user-hmac.ts`.
 *
 * Schema v1.0 vs v1.1 :
 *   - `contract_version` accepte `"1.0"` ET `"1.1"`.
 *   - v1.1 ajoute `mail_account_id?: string` (cuid d'un Account).
 *   - v1.1 ajoute `rate_limit_recipient` (429) + `account_not_found` (404).
 *   - v1.1 réponse 200 ajoute `mail_account_id_used`.
 *
 * Rate-limit per-recipient (v1.1) :
 *   - 1 mail max / 20 min / email destinataire (GLOBAL Hub-side).
 *   - S'applique sur `to[]` (chaque destinataire séparément).
 *   - cc/bcc NON rate-limités.
 *   - Si tous destinataires bloqués → 429 `rate_limit_recipient`.
 *   - Si certains OK / certains bloqués → 207 multi-status.
 *   - Header bypass `X-Veridian-Bypass-Rate-Limit: <MAIL_RATE_LIMIT_BYPASS_SECRET>`.
 *
 * Réponses :
 *   200 { message_id, provider_used, sent_at, idempotent_replay?, mail_account_id_used }
 *   207 { sent: [...], rate_limited: [{email, retry_after}] }  (v1.1 only)
 *   400 invalid_payload | invalid_json | missing headers
 *   401 invalid_hmac (signature / drift)
 *   404 user_not_found | account_not_found (v1.1)
 *   412 needs_reauth (refresh_token révoqué)
 *   422 provider_not_linked (user n'a pas connecté son Gmail)
 *   429 rate_limit | rate_limit_recipient (v1.1)
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
  MailAccountNotFoundError,
} from '@/lib/mail/send-gmail';
import {
  checkRecipientRateLimit,
  recordRecipientSent,
  recordRateLimitBlocked,
  shouldBypassRecipientRateLimit,
} from '@/lib/mail/rate-limit-recipient';

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
    /** v1.0 (legacy) ou v1.1 (multi-comptes + rate-limit per-recipient). */
    contract_version: z.enum(['1.0', '1.1']),
    /**
     * v1.1 seulement — cuid d'un Account user-side à utiliser pour cet envoi.
     * Si omis, résolution auto via isDefaultForMail puis fallback gmail.send.
     */
    mail_account_id: z.string().min(1).max(64).optional(),
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

function normalizeToList(to: string | string[]): string[] {
  return Array.isArray(to) ? to : [to];
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

  // v1.0 ne supporte pas mail_account_id : si fourni en v1.0, on rejette
  // explicitement plutôt que d'ignorer silencieusement (erreur claire pour
  // le caller — soit il bump contract_version à 1.1, soit il enlève le param).
  if (
    parsed.data.contract_version === '1.0' &&
    parsed.data.mail_account_id !== undefined
  ) {
    return jsonError('invalid_payload', 400, {
      message: 'mail_account_id requires contract_version >= 1.1',
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

  // ─── Rate-limit per-recipient (v1.1 — applique aussi à v1.0) ─────────
  // Volontairement appliqué aux DEUX versions du contract — la protection
  // anti-spam vaut pour tous les callers. La différence v1.0/v1.1 est
  // côté SHAPE du body (mail_account_id), pas côté politique RL.
  //
  // Bypass admin : header X-Veridian-Bypass-Rate-Limit + secret valide
  // (gated DEPLOY_ENV !== 'prod' + timing-safe). Robert/E2E peuvent
  // forcer un envoi sans RL.
  const recipients = normalizeToList(parsed.data.to);
  const bypass = shouldBypassRecipientRateLimit(request.headers);

  const sentRecipients: string[] = [];
  const blockedRecipients: Array<{ email: string; retry_after: number }> = [];

  if (bypass) {
    sentRecipients.push(...recipients);
  } else {
    const checks = await checkRecipientRateLimit(recipients);
    for (const check of checks) {
      if (check.allowed) {
        sentRecipients.push(check.recipient);
      } else {
        blockedRecipients.push({
          email: check.recipient,
          retry_after: check.retryAfterSeconds,
        });
        // Audit forensics : 1 row par destinataire bloqué.
        // Best-effort — on swallow l'erreur pour ne pas casser l'envoi
        // si la table est down.
        recordRateLimitBlocked({
          recipientEmail: check.recipient,
          senderUserId: parsed.data.user_id,
          appCaller: app,
          retryAfterSeconds: check.retryAfterSeconds,
        }).catch((err) => {
          console.error(
            JSON.stringify({
              tag: '[mail-rate-limit-block-audit]',
              level: 'error',
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
      }
    }

    // Tous les destinataires bloqués → 429 `rate_limit_recipient`.
    if (sentRecipients.length === 0) {
      // retry_after = min des retry_after de tous les bloqués (le caller
      // peut retry dès que le 1er est libre — il itèrera ensuite).
      const minRetry = Math.min(...blockedRecipients.map((b) => b.retry_after));
      return jsonError('rate_limit_recipient', 429, {
        recipient: blockedRecipients[0]?.email,
        retry_after_seconds: minRetry,
        rate_limited: blockedRecipients,
      });
    }
  }

  // ─── Send via broker (uniquement vers destinataires non-bloqués) ─────
  try {
    const result = await sendGmailAsUser(parsed.data.user_id, {
      // Important : seulement les sent (autorisés). En multi-status on
      // envoie 1 mail aux destinataires OK, le caller verra la liste
      // bloquée et pourra retry plus tard.
      to: sentRecipients.length === 1 ? sentRecipients[0] : sentRecipients,
      subject: parsed.data.subject,
      body_text: parsed.data.body_text,
      body_html: parsed.data.body_html,
      cc: parsed.data.cc,
      bcc: parsed.data.bcc,
      reply_to: parsed.data.reply_to,
      attachments: parsed.data.attachments,
      appSource: app,
      idempotencyKey: parsed.data.idempotency_key,
      mailAccountId: parsed.data.mail_account_id,
    });

    // ─── Record sent recipients dans le bucket RL (best-effort) ──────────
    // On marque CHAQUE destinataire qui a effectivement reçu le mail.
    // Si la table est down, on ne plante pas l'envoi (déjà parti côté Gmail).
    if (!bypass) {
      await Promise.all(
        sentRecipients.map((recipient) =>
          recordRecipientSent({
            recipientEmail: recipient,
            senderUserId: parsed.data.user_id,
            appCaller: app,
          }).catch((err) => {
            console.error(
              JSON.stringify({
                tag: '[mail-rate-limit-record]',
                level: 'error',
                recipient,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }),
        ),
      );
    }

    // Multi-status : certains bloqués → 207
    if (blockedRecipients.length > 0) {
      return NextResponse.json(
        {
          message_id: result.messageId,
          provider_used: 'google',
          sent_at: result.sentAt.toISOString(),
          idempotent_replay: result.idempotentReplay ?? false,
          mail_account_id_used: result.mailAccountIdUsed,
          sent: sentRecipients,
          rate_limited: blockedRecipients,
        },
        { status: 207 },
      );
    }

    return NextResponse.json({
      message_id: result.messageId,
      provider_used: 'google',
      sent_at: result.sentAt.toISOString(),
      idempotent_replay: result.idempotentReplay ?? false,
      mail_account_id_used: result.mailAccountIdUsed,
    });
  } catch (err) {
    if (err instanceof MailAccountNotFoundError) {
      return jsonError('account_not_found', err.status);
    }
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
