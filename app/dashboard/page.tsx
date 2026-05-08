import { redirect } from 'next/navigation';
import { TenantCard } from './components/TenantCard';
import { ProspectionCard } from './components/ProspectionCard';
import { RefreshButton } from './components/RefreshButton';
import { RetryProvisionButton } from './components/RetryProvisionButton';
import { LayoutDashboard } from 'lucide-react';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

/**
 * DASHBOARD PAGE - Version Auto-Provisioning (Auth.js + Prisma)
 *
 * Flow :
 * 1. User s'inscrit -> Tenants créés automatiquement (Twenty + Notifuse)
 * 2. User arrive sur /dashboard -> Voit l'état de ses tenants
 * 3. Clic sur "Open" :
 *    - Twenty : Si loginToken < 15min -> Auto-login, sinon -> Login manuel
 *    - Notifuse : Toujours login manuel (magic link)
 */

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/signin');
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log('[Dashboard] User authenticated:', user.id, user.email);
  }

  // Récupérer le tenant principal de l'utilisateur (mono-tenant pour l'instant)
  const tenant = await prisma.tenant.findFirst({
    where: { userId: userUuid(user) },
    select: {
      id: true,
      name: true,
      status: true,
      twentyWorkspaceId: true,
      twentySubdomain: true,
      twentyLoginToken: true,
      twentyLoginTokenCreatedAt: true,
      notifuseWorkspaceSlug: true,
      notifuseInvitationSentAt: true,
      prospectionProvisionedAt: true,
      prospectionLoginToken: true,
      prospectionLoginTokenCreatedAt: true,
      prospectionPlan: true,
    },
  });

  if (process.env.NODE_ENV !== 'production') {
    console.log('[Dashboard] Tenant data:', {
      found: !!tenant,
      id: tenant?.id,
      twenty_configured: !!tenant?.twentyWorkspaceId,
      twenty_subdomain: tenant?.twentySubdomain,
      twenty_login_token_exists: !!tenant?.twentyLoginToken,
      twenty_login_token_created_at: tenant?.twentyLoginTokenCreatedAt,
      notifuse_configured: !!tenant?.notifuseWorkspaceSlug,
      notifuse_slug: tenant?.notifuseWorkspaceSlug,
    });
  }

  // Calculer si loginToken Twenty encore valide (15min - 1min de marge)
  let twentyTokenValid = false;
  if (tenant?.twentyLoginToken && tenant?.twentyLoginTokenCreatedAt) {
    const tokenAge =
      new Date().getTime() - new Date(tenant.twentyLoginTokenCreatedAt).getTime();
    const maxAge = 14 * 60 * 1000; // 14 minutes
    twentyTokenValid = tokenAge < maxAge;
  }

  // Token Prospection valide ? (24h)
  let prospectionTokenValid = false;
  if (tenant?.prospectionLoginToken && tenant?.prospectionLoginTokenCreatedAt) {
    const tokenAge =
      new Date().getTime() -
      new Date(tenant.prospectionLoginTokenCreatedAt).getTime();
    const maxAge = 23 * 60 * 60 * 1000; // 23 hours
    prospectionTokenValid = tokenAge < maxAge;
  }

  const prospectionBaseUrl =
    process.env.NEXT_PUBLIC_PROSPECTION_URL ||
    'https://saas-prospection.staging.veridian.site';
  const prospectionLoginUrl = tenant?.prospectionLoginToken
    ? `${prospectionBaseUrl}/api/auth/token?t=${tenant.prospectionLoginToken}`
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
            <div className="font-semibold mb-1">Debug Info:</div>
            <div>User ID: {user.id}</div>
            <div>Email: {user.email}</div>
            <div>Tenant found: {tenant ? 'yes' : 'no'}</div>
            {tenant && (
              <>
                <div>Tenant ID: {tenant.id}</div>
                <div>Twenty workspace: {tenant.twentyWorkspaceId || 'not configured'}</div>
                <div>Twenty subdomain: {tenant.twentySubdomain || 'not configured'}</div>
                <div>LoginToken valid: {twentyTokenValid ? 'yes' : 'no/expired'}</div>
                <div>Notifuse workspace: {tenant.notifuseWorkspaceSlug || 'not configured'}</div>
                <div>Prospection: {tenant.prospectionProvisionedAt ? 'provisioned' : 'not provisioned'}</div>
                <div>Prospection token valid: {prospectionTokenValid ? 'yes' : 'no/expired'}</div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Status Banner */}
      {!tenant && (
        <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
          <div className="flex items-center gap-2">
            <span className="text-yellow-600 font-semibold">Provisioning in progress...</span>
          </div>
          <p className="text-sm text-yellow-700 mt-1">
            Your workspaces are being created. This may take a few moments. Please refresh the page.
          </p>
          <p className="text-xs text-yellow-600 mt-2">
            If this message persists for more than 2 minutes, try the button below.
          </p>
          <RetryProvisionButton />
        </div>
      )}

      {/* Tenant Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <TenantCard
          service="twenty"
          configured={!!tenant?.twentyWorkspaceId}
          available={twentyAvailable}
          subdomain={tenant?.twentySubdomain || undefined}
          loginTokenValid={twentyTokenValid}
          loginToken={tenant?.twentyLoginToken || undefined}
          userEmail={user.email || undefined}
        />

        <TenantCard
          service="notifuse"
          configured={!!tenant?.notifuseWorkspaceSlug}
          available={notifuseAvailable}
          slug={tenant?.notifuseWorkspaceSlug || undefined}
          tenantId={tenant?.id}
          userEmail={user.email || undefined}
        />

        <ProspectionCard
          configured={!!tenant?.prospectionProvisionedAt}
          loginUrl={prospectionLoginUrl}
          tokenValid={prospectionTokenValid}
          plan={tenant?.prospectionPlan || 'freemium'}
        />
      </div>

      {/* Info Section */}
      <div className="mt-12 p-6 bg-muted/50 rounded-lg border">
        <h3 className="font-semibold mb-3">How it works</h3>
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
            Tip: Your dashboard password works for all services. Keep it safe.
          </p>
        </div>
      </div>
    </div>
  );
}
