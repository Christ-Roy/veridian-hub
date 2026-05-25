/**
 * `sendGmailAsUser` — coeur du broker Mail Gateway v1 (Gmail-only).
 *
 * Appelé depuis :
 *   - `POST /api/mail/send-as-user` (route HMAC entrante consommée par les
 *     apps downstream Notifuse / Prospection / CMS / Analytics)
 *   - `POST /api/gmail/test-send` (route interne UI settings/mail — appSource
 *     = 'hub-test')
 *
 * Flow :
 *   1. Vérifie idempotence : si `mail_events.idempotency_key = X` existe et
 *      status='sent', retourne le résultat du 1er envoi (idempotentReplay).
 *   2. Lookup `Account` Prisma pour le user, provider='google', avec
 *      `mailSendScope` contenant `gmail.send` et `mailSendNeedsReauth = false`.
 *   3. Si access_token expiré (epoch ms < now + 60s) → refresh via
 *      `OAuth2Client.refreshAccessToken()`. Catch `invalid_grant` :
 *         - flag `Account.mailSendNeedsReauth = true`
 *         - insère mail_events row status='needs_reauth'
 *         - throw `MailNeedsReauthError`
 *   4. Construit MIME RFC 2822 :
 *         - text-only : multipart simple
 *         - html : multipart/alternative text + html
 *         - attachments : multipart/mixed wrap autour
 *         - from header = user's email (récupéré du provider lookup)
 *   5. base64url encode l'ensemble.
 *   6. Appelle `gmail.users.messages.send({ userId: 'me', requestBody: { raw } })`.
 *   7. Insère mail_events row status='sent' avec providerMessageId.
 *   8. Retourne { messageId, sentAt }.
 *
 * Erreurs typées (extends Error) :
 *   - `MailUserNotFoundError` (404)
 *   - `MailProviderNotLinkedError` (422)
 *   - `MailNeedsReauthError` (412)
 *   - `MailProviderUnreachableError` (503)
 *   - `MailRateLimitError` (429) — pas implémenté en v1 (Gmail gère ses
 *     propres 429), mais réservé pour future couche rate-limit cross-app.
 */

import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from '@/lib/prisma';
import { getMailOAuthClient, scopeIncludesGmailSend } from './gmail-oauth';

// ─── Erreurs typées ────────────────────────────────────────────────────────

export class MailUserNotFoundError extends Error {
  status = 404 as const;
  code = 'user_not_found' as const;
}

export class MailProviderNotLinkedError extends Error {
  status = 422 as const;
  code = 'provider_not_linked' as const;
}

export class MailNeedsReauthError extends Error {
  status = 412 as const;
  code = 'needs_reauth' as const;
}

export class MailProviderUnreachableError extends Error {
  status = 503 as const;
  code = 'provider_unreachable' as const;
  constructor(message: string, public cause?: unknown) {
    super(message);
  }
}

// ─── Types public ──────────────────────────────────────────────────────────

export type MailAttachment = {
  filename: string;
  content_base64: string;
  mime_type: string;
};

export type MailAppSource =
  | 'notifuse'
  | 'prospection'
  | 'cms'
  | 'analytics'
  | 'hub-test';

export type SendGmailParams = {
  to: string | string[];
  subject: string;
  body_text?: string;
  body_html?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  attachments?: MailAttachment[];
  appSource: MailAppSource;
  /** UUID v4 obligatoire pour la dédup côté DB. */
  idempotencyKey: string;
};

export type SendGmailResult = {
  messageId: string;
  sentAt: Date;
  /** True si on a re-servi le résultat d'un envoi précédent (idempotent replay). */
  idempotentReplay?: boolean;
};

// ─── Injection — permet aux tests de mock ──────────────────────────────────

export type GmailClientLike = Pick<gmail_v1.Resource$Users$Messages, 'send'>;

export type SendGmailDeps = {
  prisma?: PrismaClient;
  /** Override l'appel `OAuth2Client.refreshAccessToken` (tests). */
  refreshAccessToken?: (refreshToken: string) => Promise<{
    access_token: string;
    expires_at: number;
  }>;
  /** Fabrique un client Gmail à partir d'un access_token (tests). */
  buildGmailClient?: (accessToken: string) => GmailClientLike;
  /** Surcharge l'horloge pour les tests d'expiration. */
  now?: () => number;
};

// ─── Helpers MIME ──────────────────────────────────────────────────────────

/**
 * Encode un string en base64url (RFC 4648 §5) — alphabet URL-safe + sans
 * padding. C'est exactement ce qu'attend `gmail.users.messages.send` pour
 * le champ `raw`.
 */
export function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Échappe une string pour usage dans un header MIME `Subject:` qui peut
 * contenir des caractères non-ASCII (RFC 2047 — encoded-word). On utilise
 * l'encodage B (base64) qui gère tout proprement.
 */
function encodeSubjectHeader(subject: string): string {
  // ASCII pur ? on laisse tel quel pour lisibilité du raw.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(subject)) {
    return subject;
  }
  const b64 = Buffer.from(subject, 'utf-8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function normalizeToList(to: string | string[]): string[] {
  return Array.isArray(to) ? to : [to];
}

type BuildMimeInput = {
  from: string;
  to: string[];
  subject: string;
  body_text?: string;
  body_html?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  attachments?: MailAttachment[];
  boundary?: string;
};

/**
 * Construit un message MIME RFC 2822 prêt à être envoyé via Gmail API.
 *
 * Stratégie :
 *   - pas d'attachments + texte seul → text/plain unique
 *   - pas d'attachments + html (+/- texte) → multipart/alternative
 *   - attachments présents → multipart/mixed wrap autour de l'alternative
 *
 * `boundary` est paramétrable pour les tests déterministes. Par défaut on
 * génère un boundary unique basé sur crypto.randomUUID().
 */
export function buildMimeMessage(input: BuildMimeInput): string {
  if (!input.body_text && !input.body_html) {
    throw new Error('Either body_text or body_html is required');
  }

  const headers: string[] = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
  ];
  if (input.cc && input.cc.length > 0) {
    headers.push(`Cc: ${input.cc.join(', ')}`);
  }
  if (input.bcc && input.bcc.length > 0) {
    headers.push(`Bcc: ${input.bcc.join(', ')}`);
  }
  if (input.reply_to) {
    headers.push(`Reply-To: ${input.reply_to}`);
  }
  headers.push(`Subject: ${encodeSubjectHeader(input.subject)}`);
  headers.push('MIME-Version: 1.0');

  const hasHtml = Boolean(input.body_html);
  const hasText = Boolean(input.body_text);
  const hasAttachments = Boolean(input.attachments && input.attachments.length > 0);

  // Cas 1 : text-only, pas d'attachments
  if (!hasHtml && !hasAttachments) {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: 7bit');
    return `${headers.join('\r\n')}\r\n\r\n${input.body_text!}`;
  }

  // Cas 2 : html-only ou text+html, pas d'attachments → multipart/alternative
  const altBoundary = input.boundary
    ? `${input.boundary}-alt`
    : `alt-${cryptoRandomBoundary()}`;

  const altParts: string[] = [];
  if (hasText) {
    altParts.push(
      [
        `--${altBoundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        input.body_text!,
      ].join('\r\n'),
    );
  }
  if (hasHtml) {
    altParts.push(
      [
        `--${altBoundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        input.body_html!,
      ].join('\r\n'),
    );
  }
  const alternativeBlock = [
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    altParts.join('\r\n'),
    `--${altBoundary}--`,
  ].join('\r\n');

  if (!hasAttachments) {
    return `${headers.join('\r\n')}\r\n${alternativeBlock}`;
  }

  // Cas 3 : attachments présents → multipart/mixed wrap
  const mixedBoundary = input.boundary
    ? `${input.boundary}-mixed`
    : `mixed-${cryptoRandomBoundary()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

  const attachmentBlocks = input.attachments!.map((att) => {
    return [
      `--${mixedBoundary}`,
      `Content-Type: ${att.mime_type}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      att.content_base64,
    ].join('\r\n');
  });

  return [
    headers.join('\r\n'),
    '',
    `--${mixedBoundary}`,
    alternativeBlock,
    '',
    attachmentBlocks.join('\r\n'),
    `--${mixedBoundary}--`,
  ].join('\r\n');
}

function cryptoRandomBoundary(): string {
  // crypto.randomUUID() est dispo dans Node 19+ — sinon fallback Math.random.
  // On garde un fallback safe au cas où le runtime serait older.
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

// ─── Core function ─────────────────────────────────────────────────────────

/**
 * Envoie un mail au nom de `userId` via son Gmail connecté.
 *
 * Voir le commentaire en-tête du fichier pour le flow complet.
 */
export async function sendGmailAsUser(
  userId: string,
  params: SendGmailParams,
  deps: SendGmailDeps = {},
): Promise<SendGmailResult> {
  const prisma = deps.prisma ?? defaultPrisma;
  const now = deps.now ?? (() => Date.now());

  // ─── 1. Idempotence ─────────────────────────────────────────────────────
  const existing = await prisma.mailEvent.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
  });
  if (existing) {
    if (existing.status === 'sent' && existing.providerMessageId) {
      return {
        messageId: existing.providerMessageId,
        sentAt: existing.sentAt,
        idempotentReplay: true,
      };
    }
    // Un échec précédent (failed / needs_reauth) ne doit PAS bloquer un retry
    // mais l'idempotency_key UNIQUE empêche d'insérer une 2e row. On rejette
    // explicitement : l'app downstream doit générer un nouveau key pour retry.
    throw new MailProviderUnreachableError(
      `idempotency_key ${params.idempotencyKey} already used (previous status: ${existing.status})`,
    );
  }

  // ─── 2. Lookup Account ──────────────────────────────────────────────────
  // On charge le user pour vérifier qu'il existe ET pour récupérer son email
  // (utilisé comme From header). Throw avant de toucher Google.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });
  if (!user) {
    throw new MailUserNotFoundError(`User ${userId} not found`);
  }

  // Cherche un Account Google avec scope gmail.send et pas en needs_reauth.
  // On filtre côté code car `mailSendScope` est un CSV — pas d'op LIKE ici
  // pour rester portable.
  const candidates = await prisma.account.findMany({
    where: {
      userId,
      provider: 'google',
      mailSendNeedsReauth: false,
    },
    select: {
      id: true,
      refresh_token: true,
      access_token: true,
      expires_at: true,
      mailSendScope: true,
      mailSendNeedsReauth: true,
    },
  });

  const account = candidates.find((a) => scopeIncludesGmailSend(a.mailSendScope));
  if (!account || !account.refresh_token) {
    throw new MailProviderNotLinkedError(
      `User ${userId} has no Google Account with gmail.send scope linked`,
    );
  }

  // ─── 3. Refresh access_token si expiré (skew 60s) ───────────────────────
  // `expires_at` est stocké par Auth.js en secondes epoch (norme adapter
  // Prisma). On compare en secondes.
  const nowSec = Math.floor(now() / 1000);
  const expiresAtSec = account.expires_at ?? 0;
  let accessToken = account.access_token ?? '';
  let newExpiresAt = expiresAtSec;

  if (!accessToken || expiresAtSec - nowSec < 60) {
    try {
      const refreshed = deps.refreshAccessToken
        ? await deps.refreshAccessToken(account.refresh_token)
        : await defaultRefresh(account.refresh_token);
      accessToken = refreshed.access_token;
      newExpiresAt = Math.floor(refreshed.expires_at / 1000);

      // Persist le nouveau access_token + expires_at pour les prochains envois
      await prisma.account.update({
        where: { id: account.id },
        data: {
          access_token: refreshed.access_token,
          expires_at: newExpiresAt,
        },
      });
    } catch (err) {
      // invalid_grant = refresh révoqué (user a retiré le consent, changé son
      // mot de passe, ou l'app a été désactivée côté Google). On flag l'Account
      // et on persiste un mail_events status='needs_reauth' avant de throw.
      const message = String(err instanceof Error ? err.message : err);
      const isInvalidGrant =
        message.includes('invalid_grant') ||
        message.toLowerCase().includes('invalid grant') ||
        (typeof err === 'object' &&
          err !== null &&
          'response' in err &&
          // @ts-expect-error inspection libre d'un objet inconnu
          err.response?.data?.error === 'invalid_grant');

      if (isInvalidGrant) {
        await prisma.account.update({
          where: { id: account.id },
          data: { mailSendNeedsReauth: true },
        });
        await prisma.mailEvent.create({
          data: {
            userId,
            appSource: params.appSource,
            provider: 'google',
            recipient: normalizeToList(params.to)[0] ?? '',
            subject: params.subject,
            status: 'needs_reauth',
            errorMessage: 'invalid_grant — refresh_token revoked',
            idempotencyKey: params.idempotencyKey,
          },
        });
        throw new MailNeedsReauthError(
          `Google refresh_token revoked for user ${userId} — re-consent required`,
        );
      }

      // Autre erreur : provider unreachable (réseau, Google down, etc.). On
      // persiste un mail_events status='failed' pour l'audit puis on throw.
      await prisma.mailEvent.create({
        data: {
          userId,
          appSource: params.appSource,
          provider: 'google',
          recipient: normalizeToList(params.to)[0] ?? '',
          subject: params.subject,
          status: 'failed',
          errorMessage: `refresh_failed: ${message}`,
          idempotencyKey: params.idempotencyKey,
        },
      });
      throw new MailProviderUnreachableError(
        `Failed to refresh Google access_token: ${message}`,
        err,
      );
    }
  }

  // ─── 4. Construit MIME ──────────────────────────────────────────────────
  const mime = buildMimeMessage({
    from: user.email,
    to: normalizeToList(params.to),
    subject: params.subject,
    body_text: params.body_text,
    body_html: params.body_html,
    cc: params.cc,
    bcc: params.bcc,
    reply_to: params.reply_to,
    attachments: params.attachments,
  });

  const raw = base64UrlEncode(mime);

  // ─── 5. Send via Gmail API ──────────────────────────────────────────────
  const gmailClient = deps.buildGmailClient
    ? deps.buildGmailClient(accessToken)
    : defaultBuildGmailClient(accessToken);

  let providerMessageId: string;
  try {
    const res = await gmailClient.send({
      userId: 'me',
      requestBody: { raw },
    });
    const id = res?.data?.id;
    if (!id) {
      throw new Error('Gmail API returned no message id');
    }
    providerMessageId = id;
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    // Persist failed event pour audit
    await prisma.mailEvent.create({
      data: {
        userId,
        appSource: params.appSource,
        provider: 'google',
        recipient: normalizeToList(params.to)[0] ?? '',
        subject: params.subject,
        status: 'failed',
        errorMessage: `gmail_send_failed: ${message}`,
        idempotencyKey: params.idempotencyKey,
      },
    });
    throw new MailProviderUnreachableError(`Gmail send failed: ${message}`, err);
  }

  // ─── 6. Persist mail_events status='sent' ──────────────────────────────
  const row = await prisma.mailEvent.create({
    data: {
      userId,
      appSource: params.appSource,
      provider: 'google',
      recipient: normalizeToList(params.to)[0] ?? '',
      subject: params.subject,
      providerMessageId,
      status: 'sent',
      idempotencyKey: params.idempotencyKey,
    },
  });

  return { messageId: providerMessageId, sentAt: row.sentAt };
}

// ─── Default impls (réseau réel) ───────────────────────────────────────────

async function defaultRefresh(
  refreshToken: string,
): Promise<{ access_token: string; expires_at: number }> {
  // On utilise une redirectUri arbitraire — Google ne la check pas sur
  // refreshAccessToken (canal authentifié par secret). Le clientId/secret
  // viennent des ENV via getMailOAuthClient.
  const client = getMailOAuthClient('https://app.veridian.site/api/gmail/connect/callback');
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  if (!credentials.access_token) {
    throw new Error('Refresh returned no access_token');
  }
  return {
    access_token: credentials.access_token,
    expires_at:
      typeof credentials.expiry_date === 'number'
        ? credentials.expiry_date
        : Date.now() + 60 * 60 * 1000,
  };
}

function defaultBuildGmailClient(accessToken: string): GmailClientLike {
  const auth = getMailOAuthClient(
    'https://app.veridian.site/api/gmail/connect/callback',
  );
  auth.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: 'v1', auth });
  return gmail.users.messages;
}
