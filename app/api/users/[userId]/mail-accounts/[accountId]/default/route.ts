/**
 * POST /api/users/{userId}/mail-accounts/{accountId}/default
 *
 * Marque un Account comme défaut pour les envois `POST /api/mail/send-as-user`
 * sans `mail_account_id` explicite (v1.1+).
 *
 * Atomique : transaction Prisma qui d'abord met TOUS les Accounts du user
 * à `is_default_for_mail = false` puis set le bon à `true`. L'index unique
 * partiel WHERE = true garantit qu'il ne peut y en avoir qu'un.
 *
 * Auth : HMAC Pattern A (`<APP>_HUB_API_SECRET`), body vide → canonical = `${ts}.`
 *
 * Spec ticket : `todo/2026-05-25-mail-provider-status-endpoint.md` §2.
 *
 * Réponses :
 *   200 { user_id, account_id, is_default: true }
 *   400 invalid_payload
 *   401 invalid_hmac
 *   404 user_not_found | account_not_found
 *   429 rate_limit
 *   503 secret_not_configured
 */

import { NextRequest, NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import {
  extractClientIp,
  mailSendAsUserPreVerifyLimiter,
} from '@/lib/auth/rate-limit';
import { verifySendAsUserHmac } from '@/lib/mail/send-as-user-hmac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

function jsonError(
  code: string,
  status: number,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { error: code, ...extra },
    { status, headers: NO_STORE_HEADERS },
  );
}

type RouteParams = {
  params: Promise<{ userId: string; accountId: string }>;
};

export async function POST(request: NextRequest, ctx: RouteParams) {
  // ─── Pre-verify rate-limit (IP) ───────────────────────────────────────
  const ip = extractClientIp(request.headers);
  const preRate = mailSendAsUserPreVerifyLimiter.enforceWithBypass(
    ip,
    request.headers,
  );
  if (!preRate.ok) {
    return jsonError('rate_limit', 429, {
      retry_after: preRate.retryAfterSeconds,
    });
  }

  // ─── HMAC verify (body vide → canonical = `${ts}.`) ───────────────────
  const rawBody = await request.text();
  const hmac = verifySendAsUserHmac(request.headers, rawBody);
  if (!hmac.ok) {
    const code = hmac.status === 503 ? 'secret_not_configured' : 'invalid_hmac';
    return jsonError(code, hmac.status, { reason: hmac.reason });
  }

  // ─── Validate params ──────────────────────────────────────────────────
  const { userId, accountId } = await ctx.params;
  if (!userId || userId.length === 0 || userId.length > 64) {
    return jsonError('invalid_user_id', 400);
  }
  if (!accountId || accountId.length === 0 || accountId.length > 64) {
    return jsonError('invalid_account_id', 400);
  }

  // ─── User existence ───────────────────────────────────────────────────
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    return jsonError('user_not_found', 404);
  }

  // ─── Account check (must belong to user + must have gmail.send scope) ─
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      userId: true,
      mailSendScope: true,
    },
  });
  if (!account || account.userId !== userId) {
    // Pas 403 pour éviter de leak "ce ID existe mais pas pour toi".
    return jsonError('account_not_found', 404);
  }
  if (
    !account.mailSendScope ||
    !account.mailSendScope.includes('gmail.send')
  ) {
    // Sans gmail.send on ne peut PAS marquer par défaut — sinon
    // /api/mail/send-as-user routerait sur un Account qui ne peut pas
    // envoyer et retournerait provider_not_linked à l'app caller.
    return jsonError('account_not_eligible_for_mail', 400, {
      message: 'Account has no gmail.send scope; re-connect via OAuth Client 2 first',
    });
  }

  // ─── Transaction : reset les autres + set celui-ci ────────────────────
  // L'index unique partiel WHERE = true exige qu'il n'y ait qu'un seul
  // Account par user à true. Si on update sans reset les autres → 23505
  // violation. Donc transaction obligatoire.
  await prisma.$transaction([
    prisma.account.updateMany({
      where: { userId, isDefaultForMail: true, NOT: { id: accountId } },
      data: { isDefaultForMail: false },
    }),
    prisma.account.update({
      where: { id: accountId },
      data: { isDefaultForMail: true },
    }),
  ]);

  return NextResponse.json(
    {
      user_id: userId,
      account_id: accountId,
      is_default: true,
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
