import { createClient } from '@/utils/supabase/server';
import { NextResponse } from 'next/server';

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

    // Check what's already provisioned
    const { data: existingTenant } = await (supabase.from('tenants') as any)
      .select('id, twenty_workspace_id, prospection_provisioned_at, notifuse_workspace_id')
      .eq('user_id', user.id)
      .maybeSingle();

    const alreadyDone = {
      twenty: !!existingTenant?.twenty_workspace_id,
      prospection: !!existingTenant?.prospection_provisioned_at,
      notifuse: !!existingTenant?.notifuse_workspace_id,
    };

    if (alreadyDone.twenty && alreadyDone.prospection && alreadyDone.notifuse) {
      return NextResponse.json({ message: 'All services already provisioned', ...alreadyDone });
    }

    console.log(`[Retry Provision] Retrying for ${user.email} — current state:`, alreadyDone);

    // Re-trigger provisioning (password will be resolved from DB or generated)
    const { provisionTenants } = await import('@/utils/tenants/provision');
    const result = await provisionTenants(user.email!, '', user.id);

    return NextResponse.json({
      message: 'Provisioning completed',
      user_id: user.id,
      ...result,
    });
  } catch (error: any) {
    console.error('[Retry Provision] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Provisioning failed' },
      { status: 500 }
    );
  }
}
