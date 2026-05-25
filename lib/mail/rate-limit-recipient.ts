/**
 * Rate-limit per-recipient pour le Mail Gateway v2.
 *
 * Règle (Robert 2026-05-25) : **1 mail max / 20 minutes / email destinataire**,
 * GLOBAL Hub-side — peu importe quel user envoie via quelle app, deux
 * envois consécutifs au même `to` dans la fenêtre 20 minutes : le 2e est
 * bloqué (207 multi-status si plusieurs destinataires, 429 si tous bloqués).
 *
 * NE s'applique PAS sur `cc` / `bcc` (Robert : décide audit cross-app).
 *
 * Bypass admin/E2E :
 *   - Header `X-Veridian-Bypass-Rate-Limit: <secret>` qui matche
 *     `MAIL_RATE_LIMIT_BYPASS_SECRET` (≥ 32 chars) → bypass total.
 *   - Comparaison timing-safe.
 *   - Strictement gated `DEPLOY_ENV !== 'prod'` (sauf admin role qui sera
 *     wrappé en amont — ici on garde la gate prod).
 *
 * Storage :
 *   - `mail_recipient_rate_limit` (1 row par email) : UPSERT à chaque
 *     envoi réussi pour rolling window 20min.
 *   - `mail_rate_limit_events` (append-only) : 1 INSERT par bloqué
 *     (forensics — top destinataires bloqués, top senders).
 */

import { timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from '@/lib/prisma';

export const MAIL_RATE_LIMIT_WINDOW_MS = 20 * 60 * 1000; // 20 minutes
const WINDOW_SECONDS = Math.floor(MAIL_RATE_LIMIT_WINDOW_MS / 1000);

export const MAIL_BYPASS_HEADER = 'x-veridian-bypass-rate-limit';

export type RateLimitCheck =
  | { allowed: true; recipient: string }
  | { allowed: false; recipient: string; retryAfterSeconds: number };

export type RecordSendInput = {
  recipientEmail: string;
  senderUserId: string;
  appCaller: string;
};

export type RecordBlockInput = RecordSendInput & {
  retryAfterSeconds: number;
};

export type RateLimitDeps = {
  prisma?: PrismaClient;
  now?: () => number;
};

/**
 * Normalise l'email pour le bucket de rate-limit (lower-case + trim).
 *
 * `john@x.com` et `JOHN@X.com` doivent partager le même bucket sinon un
 * attaquant qui veut spam contourne en alternant la casse.
 */
export function normalizeRecipient(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Header bypass — vrai si le caller fournit un secret valide ET qu'on
 * accepte les bypass (hors prod par défaut).
 *
 * `allowInProd` : option d'override pour le cas admin authentifié — pour
 * l'instant on garde strict (false par défaut). Bouton "Forcer envoi"
 * Robert peut être ajouté plus tard avec admin session check.
 */
export function shouldBypassRecipientRateLimit(
  headers: Headers,
  options: { allowInProd?: boolean } = {},
): boolean {
  const allowInProd = options.allowInProd ?? false;
  if (!allowInProd && process.env.DEPLOY_ENV === 'prod') return false;

  const secret = process.env.MAIL_RATE_LIMIT_BYPASS_SECRET;
  if (!secret || secret.length < 32) return false;

  const provided = headers.get(MAIL_BYPASS_HEADER);
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) {
    // Normalise le timing (compare dummy de même longueur).
    try {
      timingSafeEqual(b, Buffer.alloc(b.length));
    } catch {
      /* noop */
    }
    return false;
  }
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Vérifie chaque destinataire séparément contre le bucket
 * `mail_recipient_rate_limit`. Retourne pour chaque email : allowed ou
 * non + retry_after_seconds si bloqué.
 *
 * Le helper NE fait pas l'INSERT — voir `recordRecipientSent` après envoi.
 */
export async function checkRecipientRateLimit(
  recipients: string[],
  deps: RateLimitDeps = {},
): Promise<RateLimitCheck[]> {
  const prisma = deps.prisma ?? defaultPrisma;
  const nowMs = deps.now ? deps.now() : Date.now();

  // Dédup + normalise pour optimiser le lookup.
  const normalized = Array.from(new Set(recipients.map(normalizeRecipient)));
  if (normalized.length === 0) return [];

  const rows = await prisma.mailRecipientRateLimit.findMany({
    where: { recipientEmail: { in: normalized } },
    select: { recipientEmail: true, lastSentAt: true },
  });

  const map = new Map<string, Date>();
  for (const row of rows) {
    map.set(row.recipientEmail, row.lastSentAt);
  }

  // Remap dans l'ordre d'entrée (en gardant chaque destinataire input
  // y compris doublons — le caller peut avoir to: [a, b, a]).
  return recipients.map((raw): RateLimitCheck => {
    const recipient = normalizeRecipient(raw);
    const lastSent = map.get(recipient);
    if (!lastSent) {
      return { allowed: true, recipient };
    }
    const ageMs = nowMs - lastSent.getTime();
    if (ageMs >= MAIL_RATE_LIMIT_WINDOW_MS) {
      return { allowed: true, recipient };
    }
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((MAIL_RATE_LIMIT_WINDOW_MS - ageMs) / 1000),
    );
    return { allowed: false, recipient, retryAfterSeconds };
  });
}

/**
 * UPSERT après un envoi réussi — UN row par destinataire. À appeler
 * pour CHAQUE destinataire passé (autorisé) après que le send Gmail
 * a réussi.
 */
export async function recordRecipientSent(
  input: RecordSendInput,
  deps: RateLimitDeps = {},
): Promise<void> {
  const prisma = deps.prisma ?? defaultPrisma;
  const nowMs = deps.now ? deps.now() : Date.now();
  const now = new Date(nowMs);
  const recipient = normalizeRecipient(input.recipientEmail);

  await prisma.mailRecipientRateLimit.upsert({
    where: { recipientEmail: recipient },
    create: {
      recipientEmail: recipient,
      lastSentAt: now,
      senderUserId: input.senderUserId,
      appCaller: input.appCaller,
    },
    update: {
      lastSentAt: now,
      senderUserId: input.senderUserId,
      appCaller: input.appCaller,
    },
  });
}

/**
 * Append-only audit : log un event "destinataire bloqué". Appelé chaque
 * fois qu'un destinataire trigger un 207 ou 429.
 */
export async function recordRateLimitBlocked(
  input: RecordBlockInput,
  deps: RateLimitDeps = {},
): Promise<void> {
  const prisma = deps.prisma ?? defaultPrisma;
  const recipient = normalizeRecipient(input.recipientEmail);

  await prisma.mailRateLimitEvent.create({
    data: {
      recipientEmail: recipient,
      senderUserId: input.senderUserId,
      appCaller: input.appCaller,
      retryAfterSeconds: input.retryAfterSeconds,
    },
  });
}

export { WINDOW_SECONDS as MAIL_RATE_LIMIT_WINDOW_SECONDS };
