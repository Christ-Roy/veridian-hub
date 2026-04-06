import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const ADMIN_EMAILS = ['brunon5robert@gmail.com'];

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * POST /api/admin/grant-plan
 * Body: { email: string, plan: "pro" | "enterprise" | "freemium" }
 *
 * Security: ADMIN_SECRET header OR authenticated admin email
 */
export async function POST(request: NextRequest) {
  // Auth: check ADMIN_SECRET header
  const adminSecret = process.env.ADMIN_SECRET;
  const headerSecret = request.headers.get('x-admin-secret');

  if (adminSecret && headerSecret === adminSecret) {
    // OK — secret matches
  } else {
    // Fallback: check if caller is an admin email via Supabase auth
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
    }
    // Try to get user from cookie/bearer
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized — provide x-admin-secret or Bearer token' }, { status: 401 });
    }
    const { data: { user }, error } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (error || !user || !ADMIN_EMAILS.includes(user.email || '')) {
      return NextResponse.json({ error: 'Forbidden — admin access only' }, { status: 403 });
    }
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

  const { email, plan } = body;
  if (!email || !plan) {
    return NextResponse.json({ error: 'email and plan required' }, { status: 400 });
  }
  if (!['freemium', 'pro', 'enterprise'].includes(plan)) {
    return NextResponse.json({ error: 'plan must be freemium, pro, or enterprise' }, { status: 400 });
  }

  // Find user by email
  const { data: users, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) {
    return NextResponse.json({ error: `User lookup failed: ${listError.message}` }, { status: 500 });
  }
  const user = users.users.find(u => u.email === email);
  if (!user) {
    return NextResponse.json({ error: `User not found: ${email}` }, { status: 404 });
  }

  // Update tenant prospection_plan
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .update({ prospection_plan: plan } as Record<string, unknown>)
    .eq('user_id', user.id)
    .select('id, name, prospection_plan')
    .single();

  if (tenantError) {
    return NextResponse.json({ error: `Tenant update failed: ${tenantError.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    user_id: user.id,
    email,
    plan,
    tenant_id: tenant.id,
    tenant_name: tenant.name,
  });
}
