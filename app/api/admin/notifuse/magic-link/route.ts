import { NextRequest, NextResponse } from 'next/server';

import { isPlatformAdmin } from '@/lib/admin/check-admin';
import { NotifuseClient } from '@/lib/notifuse/client';
import { NotifuseError } from '@/lib/notifuse/types';
import { createClient } from '@/utils/supabase/server';
import { getSupabaseAdmin } from '@/utils/supabase/admin';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { tenantId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const tenantId = body.tenantId?.trim();
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const tenantQuery = (admin.from('tenants') as any)
    .select('id, user_id, notifuse_workspace_slug, notifuse_api_key, notifuse_user_email')
    .eq('id', tenantId)
    .maybeSingle();

  const { data: tenant, error: tenantError } = await tenantQuery;

  if (tenantError) {
    return NextResponse.json({ error: tenantError.message }, { status: 500 });
  }
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  // Authorization: only the tenant owner OR a platform admin can request a magic link
  if (tenant.user_id !== user.id && !isPlatformAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!tenant.notifuse_api_key || !tenant.notifuse_user_email) {
    return NextResponse.json(
      { error: 'Tenant Notifuse workspace not provisioned' },
      { status: 409 },
    );
  }

  const apiUrl = process.env.NOTIFUSE_API_URL;
  const hubSecret = process.env.NOTIFUSE_HUB_API_SECRET;
  if (!apiUrl || !hubSecret) {
    return NextResponse.json(
      { error: 'Notifuse client not configured (NOTIFUSE_API_URL / NOTIFUSE_HUB_API_SECRET)' },
      { status: 500 },
    );
  }

  const client = new NotifuseClient({ apiUrl, hubSecret });

  try {
    const result = await client.generateMagicLink({
      apiKey: tenant.notifuse_api_key,
      userEmail: tenant.notifuse_user_email,
    });
    return NextResponse.json({
      magicLink: result.magic_link,
      expiresAt: result.expires_at,
    });
  } catch (err) {
    if (err instanceof NotifuseError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code >= 400 && err.code < 600 ? err.code : 502 },
      );
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
