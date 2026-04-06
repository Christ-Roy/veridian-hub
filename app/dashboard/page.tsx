import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import { TenantCard } from './components/TenantCard';
import { ProspectionCard } from './components/ProspectionCard';
import { RefreshButton } from './components/RefreshButton';
import { RetryProvisionButton } from './components/RetryProvisionButton';
import { LayoutDashboard } from 'lucide-react';

/**
 * DASHBOARD PAGE - Version Auto-Provisioning
 *
 * Flow :
 * 1. User s'inscrit → Tenants créés automatiquement (Twenty + Notifuse)
 * 2. User arrive sur /dashboard → Voit l'état de ses tenants
 * 3. Clic sur "Open" :
 *    - Twenty : Si loginToken < 15min → Auto-login, sinon → Login manuel
 *    - Notifuse : Toujours login manuel (magic link)
 */

// Type pour le tenant avec les nouvelles colonnes
interface TenantData {
  id: string;
  name: string;
  status: string;
  twenty_workspace_id: string | null;
  twenty_subdomain: string | null;
  twenty_login_token: string | null;
  twenty_login_token_created_at: string | null;
  notifuse_workspace_slug: string | null;
  notifuse_invitation_sent_at: string | null;
  // Prospection
  prospection_provisioned_at: string | null;
  prospection_login_token: string | null;
  prospection_login_token_created_at: string | null;
  prospection_plan: string | null;
}

export default async function DashboardPage() {
  const supabase = createClient();

  // Vérifier auth
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[Dashboard] Auth error:', authError);
    }
    redirect('/signin');
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log('[Dashboard] User authenticated:', user.id, user.email);
  }

  // Récupérer status des tenants
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
      notifuse_workspace_slug,
      notifuse_invitation_sent_at,
      prospection_provisioned_at,
      prospection_login_token,
      prospection_login_token_created_at,
      prospection_plan
    `
    )
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[Dashboard] Error fetching tenant:', error);
  }

  // Cast to our type
  const tenantData = tenant as TenantData | null;

  if (process.env.NODE_ENV !== 'production') {
    console.log('[Dashboard] Tenant data:', {
      found: !!tenantData,
      id: tenantData?.id,
      twenty_configured: !!tenantData?.twenty_workspace_id,
      twenty_subdomain: tenantData?.twenty_subdomain,
      twenty_login_token_exists: !!tenantData?.twenty_login_token,
      twenty_login_token_created_at: tenantData?.twenty_login_token_created_at,
      notifuse_configured: !!tenantData?.notifuse_workspace_slug,
      notifuse_slug: tenantData?.notifuse_workspace_slug,
    });
  }

  // Calculer si loginToken encore valide (15min - 1min de marge)
  let twentyTokenValid = false;
  if (tenantData?.twenty_login_token && tenantData?.twenty_login_token_created_at) {
    const tokenAge = new Date().getTime() - new Date(tenantData.twenty_login_token_created_at).getTime();
    const maxAge = 14 * 60 * 1000; // 14 minutes
    twentyTokenValid = tokenAge < maxAge;

    if (process.env.NODE_ENV !== 'production') {
      console.log('[Dashboard] LoginToken validity:', {
        valid: twentyTokenValid,
        age_ms: tokenAge,
        max_age_ms: maxAge,
        age_minutes: Math.floor(tokenAge / 60000),
      });
    }
  }

  // Calculer si le token Prospection est encore valide (24h)
  let prospectionTokenValid = false;
  if (tenantData?.prospection_login_token && tenantData?.prospection_login_token_created_at) {
    const tokenAge = new Date().getTime() - new Date(tenantData.prospection_login_token_created_at).getTime();
    const maxAge = 23 * 60 * 60 * 1000; // 23 hours (1h de marge)
    prospectionTokenValid = tokenAge < maxAge;
  }

  // Build the Prospection login URL from the token
  const prospectionBaseUrl = process.env.NEXT_PUBLIC_PROSPECTION_URL || 'https://saas-prospection.staging.veridian.site';
  const prospectionLoginUrl = tenantData?.prospection_login_token
    ? `${prospectionBaseUrl}/api/auth/token?t=${tenantData.prospection_login_token}`
    : null;

  // Check if Twenty/Notifuse are actually configured (not localhost placeholders)
  const twentyUrl = process.env.TWENTY_GRAPHQL_URL || '';
  const notifuseUrl = process.env.NOTIFUSE_API_URL || '';
  const twentyAvailable = !twentyUrl.includes('localhost') && twentyUrl.length > 0;
  const notifuseAvailable = !notifuseUrl.includes('localhost') && notifuseUrl.length > 0;

  return (
    <div className="container mx-auto p-8 max-w-6xl">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <LayoutDashboard className="h-10 w-10 text-primary" />
            <h1 className="text-4xl font-bold tracking-tight">My Applications</h1>
          </div>
          <RefreshButton />
        </div>
        <p className="text-muted-foreground">
          Access your Twenty CRM, Notifuse, and Prospection workspaces
        </p>

        {/* Debug info (development only) */}
        {process.env.NODE_ENV === 'development' && (
          <div className="mt-4 p-3 bg-muted rounded text-xs font-mono">
            <div className="font-semibold mb-1">🐛 Debug Info:</div>
            <div>User ID: {user.id}</div>
            <div>Email: {user.email}</div>
            <div>Tenant found: {tenantData ? '✅' : '❌'}</div>
            {tenantData && (
              <>
                <div>Tenant ID: {tenantData.id}</div>
                <div>Twenty workspace: {tenantData.twenty_workspace_id || 'not configured'}</div>
                <div>Twenty subdomain: {tenantData.twenty_subdomain || 'not configured'}</div>
                <div>LoginToken valid: {twentyTokenValid ? '✅ Yes' : '❌ No/Expired'}</div>
                <div>Notifuse workspace: {tenantData.notifuse_workspace_slug || 'not configured'}</div>
                <div>Prospection: {tenantData.prospection_provisioned_at ? '✅ Provisioned' : '❌ Not provisioned'}</div>
                <div>Prospection token valid: {prospectionTokenValid ? '✅ Yes' : '❌ No/Expired'}</div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Status Banner */}
      {!tenantData && (
        <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="flex items-center gap-2">
            <span className="text-yellow-600 font-semibold">⏳ Provisioning in progress...</span>
          </div>
          <p className="text-sm text-yellow-700 mt-1">
            Your workspaces are being created. This may take a few moments. Please refresh the page.
          </p>
          <p className="text-xs text-yellow-600 mt-2">
            💡 If this message persists for more than 2 minutes, try the button below.
          </p>
          <RetryProvisionButton />
        </div>
      )}

      {/* Tenant Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <TenantCard
          service="twenty"
          configured={!!tenantData?.twenty_workspace_id}
          available={twentyAvailable}
          subdomain={tenantData?.twenty_subdomain || undefined}
          loginTokenValid={twentyTokenValid}
          loginToken={tenantData?.twenty_login_token || undefined}
          userEmail={user.email || undefined}
        />

        <TenantCard
          service="notifuse"
          configured={!!tenantData?.notifuse_workspace_slug}
          available={notifuseAvailable}
          slug={tenantData?.notifuse_workspace_slug || undefined}
          invitationSent={!!tenantData?.notifuse_invitation_sent_at}
        />

        <ProspectionCard
          configured={!!tenantData?.prospection_provisioned_at}
          loginUrl={prospectionLoginUrl}
          tokenValid={prospectionTokenValid}
          plan={tenantData?.prospection_plan || 'freemium'}
        />
      </div>

      {/* Info Section */}
      <div className="mt-12 p-6 bg-muted/50 rounded-lg border">
        <h3 className="font-semibold mb-3">ℹ️ How it works</h3>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong>Twenty CRM:</strong> If the auto-login token is valid (less than 15 minutes old), you'll be logged in automatically. Otherwise, use your dashboard password to login manually.
          </p>
          <p>
            <strong>Notifuse:</strong> Click "Open" to access the console, then request a magic link with your email to login.
          </p>
          <p>
            <strong>Prospection:</strong> Click "Open Prospection" to access your lead qualification dashboard. A secure one-time link is generated automatically.
          </p>
          <p className="mt-4 text-xs">
            💡 <strong>Tip:</strong> Your dashboard password works for all services. Keep it safe!
          </p>
        </div>
      </div>
    </div>
  );
}
