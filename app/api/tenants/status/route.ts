import { createClient } from '@/utils/supabase/server';

export async function GET() {
  const supabase = createClient();

  try {
    // Vérifier auth
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Type pour le tenant
    type TenantData = {
      id: string;
      name: string;
      status: string;
      twenty_workspace_id: string | null;
      twenty_subdomain: string | null;
      twenty_login_token: string | null;
      twenty_login_token_created_at: string | null;
      notifuse_workspace_slug: string | null;
    };

    // Récupérer tenant
    const { data: tenant, error } = await supabase
      .from('tenants')
      .select(
        `
        id,
        name,
        status,
        twenty_workspace_id,
        twenty_subdomain,
        twenty_login_token,
        twenty_login_token_created_at,
        notifuse_workspace_slug
      `
      )
      .eq('user_id', user.id)
      .maybeSingle<TenantData>();

    if (error) {
      // Les erreurs DB sont toujours loggées
      console.error('[Tenants Status] DB Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }

    const tenantData = tenant;

    // Calculer si loginToken encore valide (15min - 1min de marge)
    const twentyTokenValid =
      tenantData?.twenty_login_token &&
      tenantData?.twenty_login_token_created_at &&
      new Date().getTime() -
        new Date(tenantData.twenty_login_token_created_at).getTime() <
        14 * 60 * 1000; // 14 minutes

    return Response.json({
      tenant_id: tenantData?.id,
      name: tenantData?.name,
      status: tenantData?.status,
      twenty: {
        configured: !!tenantData?.twenty_workspace_id,
        subdomain: tenantData?.twenty_subdomain,
        workspace_id: tenantData?.twenty_workspace_id,
        login_token_valid: twentyTokenValid,
        login_token: twentyTokenValid ? tenantData.twenty_login_token : null,
      },
      notifuse: {
        configured: !!tenantData?.notifuse_workspace_slug,
        slug: tenantData?.notifuse_workspace_slug,
      },
    });
  } catch (error: any) {
    console.error('[Tenants Status] Error:', error);
    return Response.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
