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
import { getSupabaseAdmin } from '@/utils/supabase/admin';

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

  const supabase = getSupabaseAdmin();

  // Idempotence: skip events we've already processed. The table is declared in
  // a fresh migration that hasn't been regenerated into types_db.ts yet, so we
  // bypass the typed builder.
  const events = (supabase.from as any)('notifuse_events_processed');
  const { data: existing } = await events
    .select('event_id')
    .eq('event_id', payload.event_id)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ ok: true, deduplicated: true });
  }

  try {
    await dispatchEvent(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[notifuse-webhook] dispatch failed', payload.event_type, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  await events.insert({
    event_id: payload.event_id,
    event_type: payload.event_type,
    tenant_id: payload.tenant_id,
  });

  return NextResponse.json({ ok: true });
}

async function dispatchEvent(payload: VeridianEventPayload): Promise<void> {
  const supabase = getSupabaseAdmin();
  const tenants = supabase.from('tenants') as any;
  const tenantSlug = payload.tenant_id;

  const eventType = payload.event_type as NotifuseEventType;

  switch (eventType) {
    case 'tenant.provisioned':
      // Hub initiated the provisioning, nothing to mirror — just log.
      console.info('[notifuse-webhook] tenant.provisioned', tenantSlug);
      return;

    case 'tenant.suspended': {
      const data = payload.data as TenantSuspendedEventData;
      const { error } = await tenants
        .update({
          notifuse_suspended_at: data?.suspended_at ?? new Date().toISOString(),
          notifuse_suspended_reason: data?.reason ?? null,
        })
        .eq('notifuse_workspace_slug', tenantSlug);
      if (error) throw new Error(error.message);
      return;
    }

    case 'tenant.resumed': {
      const data = payload.data as TenantResumedEventData | undefined;
      const { error } = await tenants
        .update({
          notifuse_suspended_at: null,
          notifuse_suspended_reason: null,
        })
        .eq('notifuse_workspace_slug', tenantSlug);
      if (error) throw new Error(error.message);
      console.info('[notifuse-webhook] tenant.resumed', tenantSlug, data?.resumed_at ?? '');
      return;
    }

    case 'tenant.deleted': {
      const data = payload.data as TenantDeletedEventData;
      const { error } = await tenants
        .update({
          notifuse_deleted_at: data?.deleted_at ?? new Date().toISOString(),
        })
        .eq('notifuse_workspace_slug', tenantSlug);
      if (error) throw new Error(error.message);
      return;
    }

    case 'email.sent': {
      const data = payload.data as EmailSentEventData | undefined;
      // Atomic increment via Postgres RPC (defined in migration if needed).
      // Fallback to update via raw filter — supabase-js doesn't yet support
      // SQL-side atomic increments without RPC, so we read+write and accept
      // the small race window. Counter is informational — Notifuse remains
      // source of truth.
      const { data: tenant, error: readErr } = await tenants
        .select('id, notifuse_emails_sent_this_month')
        .eq('notifuse_workspace_slug', tenantSlug)
        .maybeSingle();
      if (readErr) throw new Error(readErr.message);
      if (!tenant) {
        console.warn('[notifuse-webhook] email.sent for unknown tenant', tenantSlug);
        return;
      }
      const next = (tenant.notifuse_emails_sent_this_month ?? 0) + 1;
      const { error: writeErr } = await tenants
        .update({ notifuse_emails_sent_this_month: next })
        .eq('id', tenant.id);
      if (writeErr) throw new Error(writeErr.message);
      console.info('[notifuse-webhook] email.sent', tenantSlug, data?.message_id ?? '', '→', next);
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
      // Unknown event types are accepted (return 200) so Notifuse doesn't retry
      // forever. We just log them.
      console.info('[notifuse-webhook] unhandled event_type', eventType, tenantSlug);
      return;
  }
}
