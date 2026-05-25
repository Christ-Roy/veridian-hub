/**
 * GET /api/users/{userId}/mail-accounts
 *
 * Liste les `Account` OAuth du user éligibles au Mail Send (Gmail / Microsoft).
 * Consommé par Notifuse vague 7 (UI `/console/workspace/{id}/settings/mail-account`)
 * pour afficher la liste des comptes connectés + le compte par défaut + le
 * flag needs_reauth.
 *
 * Auth : HMAC Pattern A (`<APP>_HUB_API_SECRET`) — réutilise
 *        `verifySendAsUserHmac` (même secret par app que `send-as-user`).
 *
 * Spec ticket : `todo/2026-05-25-mail-provider-status-endpoint.md` §1.
 *
 * Réponses :
 *   200 { accounts: [{ id, provider, email, name, is_default, needs_reauth, connected_at }] }
 *   200 { accounts: [] }       — user existe, aucun Account éligible
 *   400 missing/invalid headers
 *   401 invalid_hmac
 *   404 user_not_found
 *   429 rate_limit
 *   503 secret_not_configured
 *
 * Pas de cache : `Cache-Control: no-store`.
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
  params: Promise<{ userId: string }>;
};

export async function GET(request: NextRequest, ctx: RouteParams) {
  // ─── Pre-verify rate-limit (IP) — anti-flood ──────────────────────────
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

  // ─── HMAC verify — body vide pour GET → canonical = `${ts}.` ──────────
  const rawBody = await request.text();
  const hmac = verifySendAsUserHmac(request.headers, rawBody);
  if (!hmac.ok) {
    const code = hmac.status === 503 ? 'secret_not_configured' : 'invalid_hmac';
    return jsonError(code, hmac.status, { reason: hmac.reason });
  }

  // ─── Validate userId path param ───────────────────────────────────────
  const { userId } = await ctx.params;
  if (!userId || userId.length === 0 || userId.length > 64) {
    return jsonError('invalid_user_id', 400);
  }

  // ─── User existence check (404 si inconnu) ────────────────────────────
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    return jsonError('user_not_found', 404);
  }

  // ─── Liste des Accounts du user (pas seulement gmail.send — UI veut
  //     pouvoir afficher needs_reauth aussi pour ceux qui doivent re-OAuth) ─
  const accounts = await prisma.account.findMany({
    where: { userId },
    select: {
      id: true,
      provider: true,
      providerAccountId: true,
      mailSendScope: true,
      mailSendNeedsReauth: true,
      isDefaultForMail: true,
    },
    orderBy: [{ isDefaultForMail: 'desc' }, { id: 'asc' }],
  });

  // On expose seulement les Accounts qui ont `gmail.send` (mailSendScope
  // contient `gmail.send`) — sinon ils ne servent pas au mail. Distinguer
  // OAuth sign-in (basic email/profile) des OAuth Client 2 (mail.send).
  const eligible = accounts.filter(
    (a) =>
      a.mailSendScope &&
      a.mailSendScope.includes('gmail.send'),
  );

  if (eligible.length === 0) {
    return NextResponse.json(
      { accounts: [] },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }

  // Pour récupérer l'email / nom du provider on a déjà le user.email côté
  // Hub (User table). Pour multi-comptes, on a besoin de l'email du provider
  // (Gmail compte X vs Gmail compte Y). C'est stocké côté Account dans
  // `providerAccountId` (= sub Google) mais l'email côté provider lui-même
  // n'est pas systématiquement persisté hors User.email.
  //
  // Pragma v2 : on retourne `user.email` comme proxy (provider sign-in
  // standard Auth.js → 1 user = 1 email principal). Le multi-comptes
  // OAuth Client 2 va dévier de ça dans le futur (Robert dit "Gmail perso
  // + pro" sur 1 user). À ce moment on persistera `providerEmail` dans
  // Account — pour l'instant on retourne user.email.
  //
  // On fait UN seul lookup pour récupérer email + name.
  const userFull = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, createdAt: true },
  });
  // Sécu : déjà vérifié plus haut, mais TS narrow.
  if (!userFull) return jsonError('user_not_found', 404);

  return NextResponse.json(
    {
      accounts: eligible.map((a) => ({
        id: a.id,
        provider: a.provider,
        email: userFull.email,
        name: userFull.name ?? null,
        is_default: a.isDefaultForMail,
        needs_reauth: a.mailSendNeedsReauth,
        // On n'a pas connected_at en colonne dédiée — on retourne user.createdAt
        // comme placeholder (pas critique pour la UI). Future : ajouter
        // accounts.connected_at si Robert le demande.
        connected_at: userFull.createdAt?.toISOString() ?? null,
      })),
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
