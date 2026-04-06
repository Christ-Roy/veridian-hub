import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const ADMIN_EMAILS = ['brunon5robert@gmail.com'];

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function checkAdmin(request: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET;
  const headerSecret = request.headers.get('x-admin-secret');
  if (adminSecret && headerSecret === adminSecret) return true;

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;
  const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
  return user && ADMIN_EMAILS.includes(user.email || '');
}

/**
 * GET /api/admin/list-tenants
 * Lists all tenants with user info and service status
 */
export async function GET(request: NextRequest) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  // Get all tenants
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Get all users to map emails
  const { data: usersData } = await supabase.auth.admin.listUsers();
  const userMap = new Map(
    (usersData?.users || []).map(u => [u.id, { email: u.email, created_at: u.created_at }])
  );

  const result = (tenants || []).map(t => ({
    tenant_id: t.id,
    user_id: t.user_id,
    email: userMap.get(t.user_id)?.email || 'unknown',
    user_created: userMap.get(t.user_id)?.created_at,
    name: t.name,
    status: t.status,
    plan: t.prospection_plan || 'freemium',
    trial_ends_at: t.trial_ends_at,
    services: {
      prospection: {
        provisioned: !!t.prospection_provisioned_at,
        provisioned_at: t.prospection_provisioned_at,
        plan: t.prospection_plan,
      },
      twenty: {
        provisioned: !!t.twenty_workspace_id,
        workspace_id: t.twenty_workspace_id,
        subdomain: t.twenty_subdomain,
      },
      notifuse: {
        provisioned: !!t.notifuse_workspace_id,
        workspace_id: t.notifuse_workspace_id,
      },
    },
    created_at: t.created_at,
  }));

  return NextResponse.json({
    total: result.length,
    tenants: result,
  });
}
