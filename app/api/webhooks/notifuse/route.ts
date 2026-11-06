/**
 * Webhooks Notifuse → Hub.
 *
 * Cette route gère DEUX formats coexistants :
 *
 * 1. v1.4 (contrat-hub.md §7.1, CONTRAT-HUB-API-REF.md "Webhooks app → Hub")
 *    Auth : `Authorization: Bearer <NOTIFUSE_WEBHOOK_TOKEN>`
 *    Body : { event, tenant_id, data, idempotency_key, occurred_at,
 *             contract_version }
 *    Dédup : table `hub_app.webhook_dedup` (PK app+idempotency_key, 24h)
 *    Events : `tenant.touched`, `tenant.member_role_changed`,
 *             `tenant.activity_threshold_reached`, `member_added`,
 *             `member_removed`, ... (extensible)
 *    Cas par défaut : si le handler n'existe pas encore, on persiste +
 *    renvoie 200 (stub). C'est volontaire pour permettre à Notifuse
 *    d'émettre dès aujourd'hui sans bloquer le côté Hub.
 *
 * 2. Legacy HMAC (héritage, en service en prod pour le fork Notifuse)
 *    Auth : headers `x-veridian-timestamp` + `x-veridian-notifuse-signature`
 *    Body : { event_id, event_type, tenant_id, data }
 *    Dédup : metadata.notifuse_processed_events sur la row Tenant
 *    Events : `tenant.provisioned`, `tenant.suspended`, `tenant.resumed`,
 *             `tenant.deleted`, `email.sent`, `tenant.quota_exceeded`
 *
 * Routing : si le header `authorization` est présent → on dispatche v1.4.
 * Sinon → on retombe sur le HMAC legacy. Le legacy sera retiré quand le
 * fork Notifuse aura migré (ticket v1.5+).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

import {
  BehavioralEventData,
  EmailSentEventData,
  NotifuseEventType,
  QuotaExceededEventData,
  TenantDeletedEventData,
  TenantResumedEventData,
  TenantSuspendedEventData,
  VeridianEventPayload,
} from '@/lib/notifuse/types';
import { prisma } from '@/lib/prisma';
import { handleWebhook } from '@/lib/webhooks/receiver';
import { v14Handlers } from '@/lib/webhooks/notifuse-handlers';
import { ingestProspectEvent } from '@/lib/prospect/ingest';
import {
  logWebhookAuth,
  matchRotatingSecretWith,
  readRotatingSecret,
} from '@/lib/webhooks/secret-rotation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DRIFT_MS = 5 * 60 * 1000;

// ============================================================================
// Dispatcher principal
// ============================================================================

export async function POST(request: NextRequest) {
  // Routing format : Bearer présent = v1.4, sinon legacy HMAC.
  const hasBearer = !!request.headers.get('authorization');

  if (hasBearer) {
    // Double acceptation : `NOTIFUSE_WEBHOOK_TOKEN` + éventuel
    // `NOTIFUSE_WEBHOOK_TOKEN_PREVIOUS` pendant une fenêtre de rotation.
    const token = readRotatingSecret('NOTIFUSE_WEBHOOK_TOKEN');
    if (!token) {
      return NextResponse.json(
        {
          error: 'internal_error',
          message: 'NOTIFUSE_WEBHOOK_TOKEN not configured',
        },
        { status: 500 },
      );
    }
    return handleWebhook(request, {
      app: 'notifuse',
      expectedToken: token,
      handlers: v14Handlers,
    });
  }

  return handleLegacyNotifuseHmac(request);
}

// ============================================================================
// Legacy HMAC handler (héritage Notifuse fork — à retirer plus tard)
// ============================================================================

function verifyLegacySignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_DRIFT_MS)
    return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  try {
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function handleLegacyNotifuseHmac(request: NextRequest): Promise<Response> {
  // Double acceptation : `NOTIFUSE_HUB_WEBHOOK_SECRET` + éventuel
  // `NOTIFUSE_HUB_WEBHOOK_SECRET_PREVIOUS` pendant une fenêtre de rotation.
  // La signature étant un HMAC, on ne compare pas des valeurs : on recalcule
  // la signature attendue avec chaque secret candidat.
  const secret = readRotatingSecret('NOTIFUSE_HUB_WEBHOOK_SECRET');
  if (!secret) {
    return NextResponse.json(
      { error: 'NOTIFUSE_HUB_WEBHOOK_SECRET not configured' },
      { status: 500 },
    );
  }

  const rawBody = await request.text();
  const timestamp = request.headers.get('x-veridian-timestamp');
  const signature = request.headers.get('x-veridian-notifuse-signature');

  const keyUsed = matchRotatingSecretWith(secret, (candidate) =>
    verifyLegacySignature(rawBody, timestamp, signature, candidate),
  );
  logWebhookAuth('notifuse', 'legacy-hmac', keyUsed);
  if (keyUsed === 'none') {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: VeridianEventPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!payload.event_id || !payload.event_type || !payload.tenant_id) {
    return NextResponse.json(
      { error: 'Missing required fields (event_id, event_type, tenant_id)' },
      { status: 400 },
    );
  }

  // Idempotence legacy : metadata.notifuse_processed_events (200 derniers)
  const tenant = await prisma.tenant.findFirst({
    where: { notifuseWorkspaceSlug: payload.tenant_id },
    select: { id: true, metadata: true },
  });

  if (tenant) {
    const meta = (tenant.metadata as Record<string, unknown> | null) ?? {};
    const processed = Array.isArray(meta.notifuse_processed_events)
      ? (meta.notifuse_processed_events as string[])
      : [];
    if (processed.includes(payload.event_id)) {
      return NextResponse.json({ ok: true, deduplicated: true });
    }
  }

  try {
    await dispatchLegacyEvent(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(
      '[notifuse-webhook] dispatch failed',
      payload.event_type,
      message,
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (tenant) {
    try {
      const meta = (tenant.metadata as Record<string, unknown> | null) ?? {};
      const processed = Array.isArray(meta.notifuse_processed_events)
        ? (meta.notifuse_processed_events as string[])
        : [];
      const next = [...processed, payload.event_id].slice(-200);
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          metadata: {
            ...meta,
            notifuse_processed_events: next,
          } as object,
        },
      });
    } catch (err) {
      console.warn('[notifuse-webhook] failed to mark event processed', err);
    }
  }

  return NextResponse.json({ ok: true });
}

async function dispatchLegacyEvent(
  payload: VeridianEventPayload,
): Promise<void> {
  const tenantSlug = payload.tenant_id;
  const eventType = payload.event_type as NotifuseEventType;

  const tenant = await prisma.tenant.findFirst({
    where: { notifuseWorkspaceSlug: tenantSlug },
    select: { id: true, metadata: true, prospectionConfig: true },
  });

  switch (eventType) {
    case 'tenant.provisioned':
      console.info('[notifuse-webhook] tenant.provisioned', tenantSlug);
      return;

    case 'tenant.suspended': {
      if (!tenant) return;
      const data = payload.data as TenantSuspendedEventData;
      const meta = (tenant.metadata as Record<string, unknown> | null) ?? {};
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          metadata: {
            ...meta,
            notifuse_suspended_at:
              data?.suspended_at ?? new Date().toISOString(),
            notifuse_suspended_reason: data?.reason ?? null,
          } as object,
        },
      });
      return;
    }

    case 'tenant.resumed': {
      if (!tenant) return;
      const data = payload.data as TenantResumedEventData | undefined;
      const meta = (tenant.metadata as Record<string, unknown> | null) ?? {};
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          metadata: {
            ...meta,
            notifuse_suspended_at: null,
            notifuse_suspended_reason: null,
          } as object,
        },
      });
      console.info(
        '[notifuse-webhook] tenant.resumed',
        tenantSlug,
        data?.resumed_at ?? '',
      );
      return;
    }

    case 'tenant.deleted': {
      if (!tenant) return;
      const data = payload.data as TenantDeletedEventData;
      const meta = (tenant.metadata as Record<string, unknown> | null) ?? {};
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          metadata: {
            ...meta,
            notifuse_deleted_at:
              data?.deleted_at ?? new Date().toISOString(),
          } as object,
        },
      });
      return;
    }

    case 'email.sent': {
      const data = payload.data as EmailSentEventData | undefined;
      const sentRaw = (payload.data ?? {}) as Record<string, unknown>;

      // Compteur billing (quota mensuel) : conditionné à un Tenant Hub réel.
      if (tenant) {
        const meta = (tenant.metadata as Record<string, unknown> | null) ?? {};
        const current =
          typeof meta.notifuse_emails_sent_this_month === 'number'
            ? (meta.notifuse_emails_sent_this_month as number)
            : 0;
        const next = current + 1;
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            metadata: {
              ...meta,
              notifuse_emails_sent_this_month: next,
            } as object,
          },
        });
        console.info(
          '[notifuse-webhook] email.sent',
          tenantSlug,
          data?.message_id ?? '',
          '→',
          next,
        );
      } else {
        console.warn(
          '[notifuse-webhook] email.sent for unknown tenant (counter skipped, event still ingested)',
          tenantSlug,
        );
      }

      // INCONDITIONNEL (comme opened/clicked/replied) : on ingère email.sent
      // comme event comportemental, MÊME pour un workspace orphelin (forensics).
      // Le Hub est un bus d'events : on persiste, le scoring/stage se fait dans
      // le CRM du tenant. L'adresse vient de `to` (EmailSentEventData) ou
      // `contact_email` (format comportemental).
      const sentEmail =
        typeof data?.to === 'string'
          ? data.to
          : typeof sentRaw.contact_email === 'string'
            ? (sentRaw.contact_email as string)
            : null;
      await ingestProspectEvent({
        app: 'notifuse',
        eventType: 'email.sent',
        workspaceSlug: tenantSlug,
        idempotencyKey: payload.event_id,
        occurredAt:
          typeof data?.sent_at === 'string' ? data.sent_at : payload.occurred_at,
        contactEmail: sentEmail,
        vid: typeof sentRaw.vid === 'string' ? (sentRaw.vid as string) : null,
        data: sentRaw,
      });
      return;
    }

    case 'tenant.quota_exceeded': {
      const data = payload.data as QuotaExceededEventData;
      console.warn(
        '[notifuse-webhook] tenant.quota_exceeded',
        tenantSlug,
        `${data?.emails_sent_this_month}/${data?.monthly_email_quota}`,
      );
      return;
    }

    // Events COMPORTEMENTAUX (réconciliateur cold↔web, bus d'events pur).
    // Le Hub PERSISTE l'event, point — le scoring est sorti du Hub (refactor
    // 2026-06-17), il vit dans le CRM Twenty de chaque tenant. Voie LEGACY HMAC
    // = celle qu'emprunte le fork Notifuse aujourd'hui. On normalise et on
    // délègue au MÊME ingestProspectEvent que la voie v1.4 Bearer
    // (lib/webhooks/notifuse-handlers.ts). Cf docs/CONTRAT-HUB.md §7.5.
    //
    // `event_id` legacy sert de clé d'idempotence applicative (UUID v4 généré
    // par l'émetteur Go). `tenant_id` = notifuse workspace slug.
    case 'email.opened':
    case 'email.clicked':
    case 'email.replied': {
      const data = (payload.data ?? {}) as BehavioralEventData;
      const result = await ingestProspectEvent({
        app: 'notifuse',
        eventType,
        workspaceSlug: tenantSlug,
        idempotencyKey: payload.event_id,
        occurredAt:
          typeof data.occurred_at === 'string'
            ? data.occurred_at
            : payload.occurred_at,
        contactEmail:
          typeof data.contact_email === 'string' ? data.contact_email : null,
        vid: typeof data.vid === 'string' ? data.vid : null,
        data: data as Record<string, unknown>,
      });
      console.info(
        '[notifuse-webhook] behavioral',
        eventType,
        tenantSlug,
        data.contact_email ?? '(no email)',
        // Bus d'events : on persiste l'event, le scoring se fait dans le CRM
        // du tenant. Pas de score côté Hub.
        result.ingested ? 'ingested' : 'dedup',
      );
      return;
    }

    default:
      console.info(
        '[notifuse-webhook] unhandled event_type',
        eventType,
        tenantSlug,
      );
      return;
  }
}
