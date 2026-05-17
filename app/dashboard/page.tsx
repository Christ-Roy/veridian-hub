import { redirect } from 'next/navigation';
import { TenantCard } from './components/TenantCard';
import { ProspectionCard } from './components/ProspectionCard';
import { ServiceCard } from './components/ServiceCard';
import { RefreshButton } from './components/RefreshButton';
import { RetryProvisionButton } from './components/RetryProvisionButton';
import { LayoutDashboard } from 'lucide-react';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

/**
 * DASHBOARD PAGE — Auth.js + Prisma
 *
 * Flow :
 * 1. User signup -> Tenants provisionnés (Notifuse + Prospection)
 * 2. User /dashboard -> état des tenants
 * 3. Clic "Open" :
 *    - Notifuse : magic link auto-login Hub→Notifuse
 *    - Prospection : login token one-shot
 */

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/signin');
  }

  const tenant = await prisma.tenant.findFirst({
    where: { userId: userUuid(user) },
    select: {
      id: true,
      name: true,
      status: true,
      notifuseWorkspaceSlug: true,
      notifuseInvitationSentAt: true,
      prospectionProvisionedAt: true,
      prospectionLoginToken: true,
      prospectionLoginTokenCreatedAt: true,
      prospectionPlan: true,
    },
  });

  let prospectionTokenValid = false;
  if (tenant?.prospectionLoginToken && tenant?.prospectionLoginTokenCreatedAt) {
    const tokenAge =
      new Date().getTime() -
      new Date(tenant.prospectionLoginTokenCreatedAt).getTime();
    const maxAge = 23 * 60 * 60 * 1000;
    prospectionTokenValid = tokenAge < maxAge;
  }

  const prospectionBaseUrl =
    process.env.NEXT_PUBLIC_PROSPECTION_URL ||
    'https://saas-prospection.staging.veridian.site';
  const prospectionLoginUrl = tenant?.prospectionLoginToken
    ? `${prospectionBaseUrl}/api/auth/token?t=${tenant.prospectionLoginToken}`
    : null;

  const notifuseUrl = process.env.NOTIFUSE_API_URL || '';
  const notifuseAvailable = !notifuseUrl.includes('localhost') && notifuseUrl.length > 0;

  return (
    <div className="container mx-auto p-8 max-w-6xl">
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <LayoutDashboard className="h-10 w-10 text-primary" />
            <h1 className="text-4xl font-bold tracking-tight">My Workspace</h1>
          </div>
          <RefreshButton />
        </div>
        <p className="text-muted-foreground">
          Your Veridian SaaS apps and tracking services in one place
        </p>

        {process.env.NODE_ENV === 'development' && (
          <div className="mt-4 p-3 bg-muted rounded text-xs font-mono">
            <div className="font-semibold mb-1">Debug Info:</div>
            <div>User ID: {user.id}</div>
            <div>Email: {user.email}</div>
            <div>Tenant found: {tenant ? 'yes' : 'no'}</div>
            {tenant && (
              <>
                <div>Tenant ID: {tenant.id}</div>
                <div>Notifuse workspace: {tenant.notifuseWorkspaceSlug || 'not configured'}</div>
                <div>Prospection: {tenant.prospectionProvisionedAt ? 'provisioned' : 'not provisioned'}</div>
                <div>Prospection token valid: {prospectionTokenValid ? 'yes' : 'no/expired'}</div>
              </>
            )}
          </div>
        )}
      </div>

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

      <section className="mb-12">
        <div className="mb-4">
          <h2 className="text-2xl font-semibold tracking-tight">Vos SaaS</h2>
          <p className="text-sm text-muted-foreground">
            Vos espaces de travail provisionnés automatiquement à l&apos;inscription.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <ProspectionCard
            configured={!!tenant?.prospectionProvisionedAt}
            loginUrl={prospectionLoginUrl}
            tokenValid={prospectionTokenValid}
            plan={tenant?.prospectionPlan || 'freemium'}
          />

          <TenantCard
            service="notifuse"
            configured={!!tenant?.notifuseWorkspaceSlug}
            available={notifuseAvailable}
            slug={tenant?.notifuseWorkspaceSlug || undefined}
            tenantId={tenant?.id}
            userEmail={user.email || undefined}
          />
        </div>
      </section>

      <section className="mb-12">
        <div className="mb-4">
          <h2 className="text-2xl font-semibold tracking-tight">Services de suivi</h2>
          <p className="text-sm text-muted-foreground">
            Outils de tracking et reporting pour piloter vos performances.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <ServiceCard
            name="Veridian Analytics"
            description="Dashboard multi-tenant : pageviews, formulaires, SEO (GSC), appels SIP."
            url="https://analytics.app.veridian.site"
            icon="BarChart3"
            badge="BETA"
            features={[
              'Tracker JS humain-only',
              'Sync Google Search Console',
              'Tracking appels OVH SIP',
              'Vue par client (multi-tenant)',
            ]}
          />
        </div>
      </section>

      <div className="mt-12 p-6 bg-muted/50 rounded-lg border">
        <h3 className="font-semibold mb-3">How it works</h3>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong>Notifuse :</strong> Click &ldquo;Open&rdquo; pour ouvrir la console via un magic link auto-login (TTL 60s, généré à la volée par le Hub).
          </p>
          <p>
            <strong>Prospection :</strong> Click &ldquo;Open Prospection&rdquo; pour accéder au dashboard de qualification de leads. Lien sécurisé one-shot.
          </p>
          <p className="mt-4 text-xs">
            Astuce : Ton mot de passe dashboard fonctionne pour tous les services. Garde-le en sécurité.
          </p>
        </div>
      </div>
    </div>
  );
}
