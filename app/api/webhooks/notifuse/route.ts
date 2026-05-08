import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

import {
  EmailSentEventData,
  NotifuseEventType,
  QuotaExceededEventData,
  TenantDeletedEventData,
  TenantResumedEventData,
  TenantSuspendedEventData,
  VeridianEventPayload,
} from '@/lib/notifuse/types';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DRIFT_MS = 5 * 60 * 1000;

function verifySignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_DRIFT_MS) return false;
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

export async function POST(request: NextRequest) {
  const secret = process.env.NOTIFUSE_HUB_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'NOTIFUSE_HUB_WEBHOOK_SECRET not configured' },
      { status: 500 },
    );
  }

  const rawBody = await request.text();
  const timestamp = request.headers.get('x-veridian-timestamp');
  const signature = request.headers.get('x-veridian-notifuse-signature');

  if (!verifySignature(rawBody, timestamp, signature, secret)) {
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

  // Idempotence : on stocke event_id dans le tenant.metadata.notifuse_processed_events
  // (limité à 200 derniers). La table dédiée `notifuse_events_processed` n'a pas
  // (encore) été ajoutée au schema Prisma — TODO LOT D : créer le modèle dédié.
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
    await dispatchEvent(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[notifuse-webhook] dispatch failed', payload.event_type, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Marquer event_id comme traité (best-effort)
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
          metadata: { ...meta, notifuse_processed_events: next } as object,
        },
      });
    } catch (err) {
      console.warn('[notifuse-webhook] failed to mark event processed', err);
    }
  }

  return NextResponse.json({ ok: true });
}

async function dispatchEvent(payload: VeridianEventPayload): Promise<void> {
  const tenantSlug = payload.tenant_id;
  const eventType = payload.event_type as NotifuseEventType;

  // Resolve tenant
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
            notifuse_suspended_at: data?.suspended_at ?? new Date().toISOString(),
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
            notifuse_deleted_at: data?.deleted_at ?? new Date().toISOString(),
          } as object,
        },
      });
      return;
    }

    case 'email.sent': {
      const data = payload.data as EmailSentEventData | undefined;
      if (!tenant) {
        console.warn('[notifuse-webhook] email.sent for unknown tenant', tenantSlug);
        return;
      }
      // Counter dans metadata (Notifuse reste source de vérité — informatif).
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
      return;
    }

    case 'tenant.quota_exceeded': {
      const data = payload.data as QuotaExceededEventData;
      console.warn(
        '[notifuse-webhook] tenant.quota_exceeded',
        tenantSlug,
        `${data?.emails_sent_this_month}/${data?.monthly_email_quota}`,
      );
      // TODO: déclencher mail au tenant via Brevo (separate task)
      return;
    }

    default:
      console.info('[notifuse-webhook] unhandled event_type', eventType, tenantSlug);
      return;
  }
}
