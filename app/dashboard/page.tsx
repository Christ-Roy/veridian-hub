import { redirect } from 'next/navigation';
import { TenantCard } from './components/TenantCard';
import { ProspectionCard } from './components/ProspectionCard';
import { CrmCard } from './components/CrmCard';
import { ServiceCard } from './components/ServiceCard';
import { ShadowAppCard } from './components/ShadowAppCard';
import { OnboardingChecklist } from './components/OnboardingChecklist';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { LayoutDashboard } from 'lucide-react';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { APPS } from '@/lib/pricing/plans';
import { getEnabledGatedApps } from '@/lib/tenant-apps';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * DASHBOARD PAGE — Auth.js + Prisma
 *
 * Flow on-demand (depuis 2026-05-18) :
 * 1. User signup -> AUCUN provisioning automatique.
 * 2. User /dashboard -> voit les cartes d'apps avec "Commencer l'essai gratuit".
 * 3. Clic "Commencer" -> POST /api/tenants/start { app } -> provisionne UNE app
 *    -> reload + auto-open dans nouvel onglet.
 * 4. Clic "Open" sur une app déjà provisionnée :
 *    - Notifuse : magic link auto-login Hub→Notifuse
 *    - Prospection : login token one-shot
 */

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ debug?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const params = await searchParams;
  const showDebug = process.env.NODE_ENV === 'development' && params.debug === '1';

  // CRM tenant lookup — best-effort, n'empêche pas le dashboard si fail.
  const crmTenant = await prisma.crmTenant
    .findFirst({
      where: { userId: user.id, status: 'active' },
      select: { id: true },
    })
    .catch((err) => {
      console.error('[Dashboard] Failed to fetch CRM tenant:', err);
      return null;
    });

  // Apps GATED activées pour ce tenant (twenty/CRM, analytics, cms) — pilotées
  // par Robert via l'Admin API. Défaut OFF : sans activation explicite, ces
  // cards restent en mode "Bientôt" (ShadowAppCard). Prospection + Notifuse
  // ne sont PAS concernés (toujours grand public). Lecture par UUID bridge.
  const enabledApps = await getEnabledGatedApps(prisma, userUuid(user));
  const isTwentyEnabled = enabledApps.has('twenty');
  const isAnalyticsEnabled = enabledApps.has('analytics');
  const isCmsEnabled = enabledApps.has('cms');

  const tenant = await prisma.tenant.findFirst({
    where: { userId: userUuid(user) },
    select: {
      id: true,
      name: true,
      status: true,
      notifuseWorkspaceSlug: true,
      notifuseInvitationSentAt: true,
      notifusePlan: true,
      prospectionProvisionedAt: true,
      prospectionLoginToken: true,
      prospectionLoginTokenCreatedAt: true,
      prospectionPlan: true,
      metadata: true,
    },
  });

  // Workspace réel du user — auto-créé au signup (commit 29737a4). Sert au
  // titre dynamique de la page et au repère d'onboarding. `_count.members`
  // permet de savoir si le user a déjà invité quelqu'un. Tout échec DB →
  // fallback silencieux (le dashboard reste affichable).
  const workspace = await prisma.workspace
    .findFirst({
      where: {
        members: { some: { userId: user.id } },
        deletedAt: null,
      },
      select: { name: true, _count: { select: { members: true } } },
    })
    .catch((err) => {
      console.error('[Dashboard] Failed to fetch workspace:', err);
      return null;
    });
  const workspaceName = workspace?.name ?? 'Mon espace de travail';

  // Heuristique d'onboarding (pas de colonne `onboardingCompleted`, donc pas
  // de migration DB) : l'onboarding est en cours tant qu'aucune app n'a été
  // démarrée. Contrairement à l'ancien repère gardé sur `!tenant`, il ne
  // disparaît pas au premier trial — il disparaît à la première app démarrée.
  const hasStartedApp =
    !!tenant?.prospectionProvisionedAt || !!tenant?.notifuseWorkspaceSlug;
  const hasInvitedMember = (workspace?._count.members ?? 1) > 1;

  // §8.9.4 : tenants avec un plan offert "lifetime_site_vitrine" voient
  // Analytics + CMS comme apps actives. Détecté via metadata.notifuse_plan_source
  // (la seule trace du plan_source qu'on a aujourd'hui côté Hub — à étendre
  // quand on aura une colonne typée plan_source).
  const meta = (tenant?.metadata as Record<string, unknown> | null) ?? {};
  const planSource = meta.notifuse_plan_source as string | undefined;
  const hasLifetimeSiteVitrine =
    planSource === 'lifetime_site_vitrine' ||
    tenant?.notifusePlan === 'lifetime_site_vitrine';

  // Fallback "mode service" (cf. ticket admin-api-tenant-provisioning) :
  // si un tenant a été provisionné via `POST /api/admin/tenants/link-app`,
  // les metadata.cms / metadata.analytics contiennent les infos d'accès.
  // C'est le quick-win en attendant le pattern discovery (3-4 semaines).
  type AppMetadata = {
    external_tenant_slug?: string;
    tenant_name?: string;
    plan?: string;
    fallback_url?: string;
  } | null;
  const cmsMeta = (meta.cms as AppMetadata) ?? null;
  const analyticsMeta = (meta.analytics as AppMetadata) ?? null;
  const hasServiceCms = !!cmsMeta?.fallback_url;
  const hasServiceAnalytics = !!analyticsMeta?.fallback_url;
  // Une card service est "active" si : activée par l'admin (flag TenantApp,
  // défaut OFF) OU déjà servie via metadata link-app OU plan lifetime vitrine.
  const showActiveAnalytics =
    isAnalyticsEnabled || hasLifetimeSiteVitrine || hasServiceAnalytics;
  const showActiveCms = isCmsEnabled || hasLifetimeSiteVitrine || hasServiceCms;

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
    <div className="container mx-auto p-4 sm:p-6 lg:p-8 max-w-6xl">
      <DashboardPageHeader
        title={workspaceName}
        description="Tous vos outils Veridian réunis au même endroit"
        icon={LayoutDashboard}
        className="mb-8"
      />

      {showDebug && (
        <div className="mb-8 p-3 bg-muted rounded text-xs font-mono">
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

      <OnboardingChecklist
        workspaceName={workspaceName}
        hasStartedApp={hasStartedApp}
        hasInvitedMember={hasInvitedMember}
      />

      <section className="mb-12">
        <div className="mb-4">
          <h2 className="text-2xl font-semibold tracking-tight">Vos outils</h2>
          <p className="text-sm text-muted-foreground">
            Activez les outils qui vous intéressent, chacun de façon indépendante.
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

          {/* Analytics / CMS remontent ici une fois activés */}
          {showActiveAnalytics && (
            <ServiceCard
              name={
                analyticsMeta?.tenant_name
                  ? `${APPS.analytics.display_name} — ${analyticsMeta.tenant_name}`
                  : APPS.analytics.display_name
              }
              description={APPS.analytics.tagline}
              url={analyticsMeta?.fallback_url ?? 'https://analytics.app.veridian.site'}
              icon="BarChart3"
              appKey="analytics"
              badge="BETA"
              features={[
                'Qui vous contacte, et depuis quelle source',
                'Retour sur investissement du site et des emails',
                'Suivi de vos appels téléphoniques',
                'Toutes les performances de votre site',
              ]}
            />
          )}
          {showActiveCms && (
            <ServiceCard
              name={
                cmsMeta?.tenant_name
                  ? `${APPS.cms.display_name} — ${cmsMeta.tenant_name}`
                  : APPS.cms.display_name
              }
              description={APPS.cms.tagline}
              url={cmsMeta?.fallback_url ?? 'https://cms.app.veridian.site'}
              icon="FileText"
              appKey="cms"
              badge="BETA"
              features={[
                'Modifiez votre site vous-même',
                'Textes et pages en quelques clics',
                'Ajoutez vos photos et documents',
                'Prévisualisez avant de publier',
              ]}
            />
          )}
        </div>
      </section>

      {/* Section "Inclus avec votre site web" : uniquement les services pas
          encore activés (les actifs ont remonté dans "Vos outils"). Masquée
          si tout est déjà activé. */}
      {(!showActiveAnalytics || !showActiveCms) && (
        <section className="mb-12">
          <div className="mb-4">
            <h2 className="text-2xl font-semibold tracking-tight">
              Inclus avec votre site web
            </h2>
            <p className="text-sm text-muted-foreground">
              Ces services sont offerts avec votre site web Veridian.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {!showActiveAnalytics && <ShadowAppCard app={APPS.analytics} />}
            {!showActiveCms && <ShadowAppCard app={APPS.cms} />}
          </div>
        </section>
      )}

      {/* Section "Prochainement" : outils annoncés, pas encore disponibles. */}
      <section className="mb-12">
        <div className="mb-4">
          <h2 className="text-2xl font-semibold tracking-tight">Prochainement</h2>
          <p className="text-sm text-muted-foreground">
            De nouveaux outils arrivent bientôt dans votre espace Veridian.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <CrmCard configured={!!crmTenant} enabled={isTwentyEnabled} />
        </div>
      </section>

      <Card className="relief-card mt-12 border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Comment ça marche</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong>Activez ce qui vous est utile :</strong> chaque outil
            s&apos;active en un clic. Vous n&apos;activez que ceux dont vous
            avez besoin, quand vous en avez besoin.
          </p>
          <p>
            <strong>Un seul compte pour tout :</strong> une fois connecté,
            vous accédez à chaque outil sans avoir à vous reconnecter ni à
            gérer plusieurs mots de passe.
          </p>
          <p className="mt-4 text-xs">
            Vos accès sont sécurisés et centralisés depuis votre espace
            Veridian.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
