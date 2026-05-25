/**
 * POST /api/gmail/test-send
 *
 * Route interne consommée par l'UI `/dashboard/settings/mail`. Permet à
 * l'user loggué d'envoyer un mail de test à sa propre adresse pour valider
 * que le flow OAuth Gmail + envoi via broker marche bout-en-bout.
 *
 * Auth : session Auth.js (PAS HMAC — c'est l'user lui-même qui clique).
 * AppSource : 'hub-test' (distinct des envois apps downstream — visible
 * dans l'audit `mail_events`).
 *
 * Body : aucun (le destinataire = email user, sujet/corps figés).
 * Réponses : 200 { message_id, sent_at } | 401 | 412 | 422 | 503
 */

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth/get-user';
import {
  sendGmailAsUser,
  MailProviderNotLinkedError,
  MailNeedsReauthError,
  MailProviderUnreachableError,
} from '@/lib/mail/send-gmail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await sendGmailAsUser(user.id, {
      to: user.email,
      subject: 'Test Veridian Mail Gateway',
      body_text:
        'Hello,\n\nThis is a test email sent via the Veridian Mail Gateway ' +
        '(Hub → Gmail API) using your own Gmail account.\n\n' +
        'If you received this, your Gmail connection is working correctly.\n\n' +
        '— Veridian',
      body_html: `
<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
    <h2 style="color: #0f172a;">Test Veridian Mail Gateway</h2>
    <p style="color: #475569;">Hello,</p>
    <p style="color: #475569;">
      This is a test email sent via the <strong>Veridian Mail Gateway</strong>
      (Hub → Gmail API) using your own Gmail account.
    </p>
    <p style="color: #475569;">
      If you received this, your Gmail connection is working correctly.
    </p>
    <p style="color: #94a3b8; font-size: 13px;">— Veridian</p>
  </body>
</html>`.trim(),
      appSource: 'hub-test',
      idempotencyKey: randomUUID(),
    });

    return NextResponse.json({
      ok: true,
      message_id: result.messageId,
      sent_at: result.sentAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof MailProviderNotLinkedError) {
      return NextResponse.json(
        {
          error: 'provider_not_linked',
          message:
            'No Gmail account linked. Click "Connect my Gmail" first.',
        },
        { status: 422 },
      );
    }
    if (err instanceof MailNeedsReauthError) {
      return NextResponse.json(
        {
          error: 'needs_reauth',
          message:
            'Gmail authorization was revoked. Click "Reconnect" to grant access again.',
        },
        { status: 412 },
      );
    }
    if (err instanceof MailProviderUnreachableError) {
      return NextResponse.json(
        { error: 'provider_unreachable', message: err.message },
        { status: 503 },
      );
    }
    console.error(
      JSON.stringify({
        tag: '[gmail-test-send]',
        level: 'error',
        msg: 'unexpected_error',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
