/**
 * POST /api/gmail/disconnect
 *
 * Déconnecte le compte Gmail de l'user :
 *   1. Récupère l'Account Google de l'user.
 *   2. Revoke le refresh_token côté Google (via `oauth2.revoke`). Best-effort —
 *      si la requête échoue (Google injoignable, token déjà invalide), on
 *      continue.
 *   3. Clear le refresh_token, access_token, mailSendScope côté Hub +
 *      reset mailSendNeedsReauth = false.
 *
 * On ne SUPPRIME PAS la row Account — l'user reste signin-able via Google
 * (basic scopes), c'est juste l'autorisation gmail.send qui est retirée.
 *
 * Sécurité : session Auth.js obligatoire, on ne touche QUE les Accounts du
 * user courant (pas de paramètre accountId).
 */

import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const account = await prisma.account.findFirst({
    where: {
      userId: user.id,
      provider: 'google',
      mailSendScope: { not: null },
    },
    select: { id: true, refresh_token: true },
  });

  if (!account) {
    return NextResponse.json(
      { ok: true, message: 'No Gmail account linked, nothing to disconnect' },
      { status: 200 },
    );
  }

  // Best-effort revoke côté Google. Le endpoint accepte access_token OU
  // refresh_token (https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).
  // Timeout 5s OBLIGATOIRE : sans AbortController, si Google est lent/down, la
  // requête disconnect HANG indéfiniment (le user reste bloqué sur "déconnexion").
  // Un best-effort ne doit jamais pouvoir bloquer la requête.
  if (account.refresh_token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(account.refresh_token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: controller.signal,
        },
      );
    } catch (err) {
      console.warn(
        JSON.stringify({
          tag: '[mail-oauth]',
          msg: 'revoke_failed_continuing',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  await prisma.account.update({
    where: { id: account.id },
    data: {
      refresh_token: null,
      access_token: null,
      expires_at: null,
      mailSendScope: null,
      mailSendNeedsReauth: false,
    },
  });

  return NextResponse.json({ ok: true });
}
