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
 * DELETE /api/admin/delete-tenant
 * Body: { email: string, confirm: true }
 *
 * Deletes tenant row + Supabase auth user.
 * Does NOT delete Twenty/Notifuse workspaces (those need manual cleanup).
 */
export async function DELETE(request: NextRequest) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { email, confirm } = body;
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }
  if (confirm !== true) {
    return NextResponse.json({ error: 'Set confirm: true to proceed (destructive action)' }, { status: 400 });
  }

  // Find user
  const { data: usersData } = await supabase.auth.admin.listUsers();
  const user = usersData?.users.find(u => u.email === email);
  if (!user) {
    return NextResponse.json({ error: `User not found: ${email}` }, { status: 404 });
  }

  const actions: string[] = [];

  // Delete tenant row
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, twenty_workspace_id, notifuse_workspace_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (tenant) {
    await supabase.from('tenants').delete().eq('id', tenant.id);
    actions.push(`Deleted tenant ${tenant.id}`);

    if (tenant.twenty_workspace_id) {
      actions.push(`⚠️ Twenty workspace ${tenant.twenty_workspace_id} still exists (manual cleanup needed)`);
    }
    if (tenant.notifuse_workspace_id) {
      actions.push(`⚠️ Notifuse workspace ${tenant.notifuse_workspace_id} still exists (manual cleanup needed)`);
    }
  } else {
    actions.push('No tenant row found');
  }

  // Delete subscriptions
  const { count: subCount } = await supabase
    .from('subscriptions')
    .delete({ count: 'exact' })
    .eq('user_id', user.id);
  if (subCount) actions.push(`Deleted ${subCount} subscription(s)`);

  // Delete customer
  const { count: custCount } = await supabase
    .from('customers')
    .delete({ count: 'exact' })
    .eq('id', user.id);
  if (custCount) actions.push(`Deleted customer record`);

  // Delete profile
  const { count: profCount } = await supabase
    .from('profiles')
    .delete({ count: 'exact' })
    .eq('id', user.id);
  if (profCount) actions.push(`Deleted profile`);

  // Delete Supabase auth user (last, so we have the ID for everything above)
  const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
  if (deleteError) {
    actions.push(`⚠️ Auth user delete failed: ${deleteError.message}`);
  } else {
    actions.push('Deleted auth user');
  }

  return NextResponse.json({
    ok: true,
    email,
    user_id: user.id,
    actions,
  });
}
