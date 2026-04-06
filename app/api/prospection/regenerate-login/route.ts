import { createClient } from '@/utils/supabase/server';
import { NextResponse } from 'next/server';

/**
 * POST /api/prospection/regenerate-login
 *
 * Regenerates a one-time login URL for the Prospection app.
 * Calls the Prospection provision API (which does an upsert) to get a fresh token.
 */
export async function POST() {
  try {
    const supabase = createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const PROSPECTION_URL = process.env.PROSPECTION_API_URL;
    const PROSPECTION_SECRET = process.env.PROSPECTION_TENANT_API_SECRET;

    if (!PROSPECTION_URL || !PROSPECTION_SECRET) {
      return NextResponse.json(
        { error: 'Prospection not configured' },
        { status: 500 }
      );
    }

    // Call provision endpoint (it does an upsert — creates a new token each time)
    const res = await fetch(`${PROSPECTION_URL}/api/tenants/provision`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PROSPECTION_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: user.email,
        name: user.user_metadata?.full_name || user.email?.split('@')[0],
        plan: 'freemium',
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error('[Prospection Regenerate] API error:', res.status, errorText);
      return NextResponse.json(
        { error: `Provision failed: ${res.status}` },
        { status: 502 }
      );
    }

    const data = await res.json();

    // Update the tenant record with the new token
    // Type cast: Supabase strict mode infers `never` for tenants table (enum + new columns conflict)
    const db = supabase.from('tenants') as any;
    const { data: tenant } = await db.select('id').eq('user_id', user.id).maybeSingle();

    if (tenant) {
      const newToken = data.login_url?.split('t=')[1] ?? null;
      const { error: updateError } = await db.update({
        prospection_login_token: newToken,
        prospection_login_token_created_at: new Date().toISOString(),
        prospection_login_token_used: false,
      }).eq('id', tenant.id);

      if (updateError) {
        console.error('[Prospection Regenerate] Failed to persist token in Supabase:', updateError.message);
        // Fallback: try with admin client if RLS blocks the update
        try {
          const { getSupabaseAdmin } = await import('@/utils/supabase/admin');
          const admin = getSupabaseAdmin();
          await (admin.from('tenants') as any).update({
            prospection_login_token: newToken,
            prospection_login_token_created_at: new Date().toISOString(),
            prospection_login_token_used: false,
          }).eq('id', tenant.id);
          console.log('[Prospection Regenerate] Token persisted via admin fallback');
        } catch (fbErr: any) {
          console.error('[Prospection Regenerate] Admin fallback also failed:', fbErr.message);
        }
      } else {
        console.log(`[Prospection Regenerate] Token persisted for tenant ${tenant.id}`);
      }
    } else {
      console.warn(`[Prospection Regenerate] No tenant found for user ${user.id} — token not persisted`);
    }

    return NextResponse.json({
      login_url: data.login_url,
      tenant_id: data.tenant_id,
    });
  } catch (error: any) {
    console.error('[Prospection Regenerate] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
