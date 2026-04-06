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
 * POST /api/admin/impersonate
 * Body: { email: string }
 *
 * Generates auto-login URLs for all services for a given user.
 * Useful for debugging/support — login as any user without knowing their password.
 */
export async function POST(request: NextRequest) {
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

  const { email } = body;
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }

  // Find user
  const { data: usersData } = await supabase.auth.admin.listUsers();
  const user = usersData?.users.find(u => u.email === email);
  if (!user) {
    return NextResponse.json({ error: `User not found: ${email}` }, { status: 404 });
  }

  // Get tenant
  const { data: tenant } = await supabase
    .from('tenants')
    .select('*')
    .eq('user_id', user.id)
    .single();

  // Generate Prospection auto-login token
  let prospectionUrl = null;
  const prospectionApiUrl = process.env.PROSPECTION_API_URL;
  const prospectionSecret = process.env.PROSPECTION_TENANT_API_SECRET;
  const prospectionPublicUrl = process.env.NEXT_PUBLIC_PROSPECTION_URL || 'https://prospection.app.veridian.site';

  if (prospectionApiUrl && prospectionSecret) {
    try {
      const provRes = await fetch(`${prospectionApiUrl}/api/tenants/provision`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${prospectionSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, name: email.split('@')[0], plan: tenant?.prospection_plan || 'freemium' }),
      });
      if (provRes.ok) {
        const provData = await provRes.json();
        prospectionUrl = provData.login_url;

        // Store token in tenants
        if (provData.login_url) {
          const token = provData.login_url.split('t=')[1];
          await supabase
            .from('tenants')
            .update({
              prospection_login_token: token,
              prospection_login_token_created_at: new Date().toISOString(),
              prospection_login_token_used: false,
            })
            .eq('user_id', user.id);
        }
      }
    } catch { /* non-blocking */ }
  }

  // Generate magic link for hub login
  const { data: magicLink } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });

  const hubUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://app.veridian.site';

  return NextResponse.json({
    user_id: user.id,
    email,
    tenant_id: tenant?.id || null,
    links: {
      hub: magicLink?.properties?.action_link
        ? `${hubUrl}/auth/confirm?token_hash=${encodeURIComponent(magicLink.properties.hashed_token)}&type=magiclink`
        : null,
      prospection: prospectionUrl,
      twenty: tenant?.twenty_subdomain
        ? `https://twenty.app.veridian.site`
        : null,
      notifuse: tenant?.notifuse_workspace_id
        ? `https://notifuse.app.veridian.site`
        : null,
    },
  });
}
