import { redirect } from 'next/navigation';
import { TenantCard } from './components/TenantCard';
import { ProspectionCard } from './components/ProspectionCard';
import { ServiceCard } from './components/ServiceCard';
import { ShadowAppCard } from './components/ShadowAppCard';
import { RefreshButton } from './components/RefreshButton';
import { OnboardingChecklist } from './components/OnboardingChecklist';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { LayoutDashboard } from 'lucide-react';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { APPS } from '@/lib/pricing/plans';
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
  const showActiveAnalytics = hasLifetimeSiteVitrine || hasServiceAnalytics;
  const showActiveCms = hasLifetimeSiteVitrine || hasServiceCms;

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
      <DashboardPageHeader
        title={workspaceName}
        description="Vos apps SaaS et services de suivi Veridian réunis au même endroit"
        icon={LayoutDashboard}
        action={<RefreshButton />}
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
          <h2 className="text-2xl font-semibold tracking-tight">Vos SaaS</h2>
          <p className="text-sm text-muted-foreground">
            Active chaque app indépendamment. Tu peux tester juste celle qui
            t&apos;intéresse.
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
          <h2 className="text-2xl font-semibold tracking-tight">
            Apps réservées clients sites vitrines
          </h2>
          <p className="text-sm text-muted-foreground">
            {hasLifetimeSiteVitrine || hasServiceCms || hasServiceAnalytics
              ? "Apps incluses dans ton offre site vitrine Veridian."
              : "Ces apps sont incluses avec l'achat d'un site vitrine Veridian."}
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {showActiveAnalytics ? (
            <ServiceCard
              name={
                analyticsMeta?.tenant_name
                  ? `${APPS.analytics.display_name} — ${analyticsMeta.tenant_name}`
                  : APPS.analytics.display_name
              }
              description={APPS.analytics.tagline}
              url={analyticsMeta?.fallback_url ?? 'https://analytics.app.veridian.site'}
              icon="BarChart3"
              badge="BETA"
              features={[
                'Tracker JS humain-only',
                'Sync Google Search Console',
                'Tracking appels OVH SIP',
                'Vue par client (multi-tenant)',
              ]}
            />
          ) : (
            <ShadowAppCard app={APPS.analytics} />
          )}
          {showActiveCms ? (
            <ServiceCard
              name={
                cmsMeta?.tenant_name
                  ? `${APPS.cms.display_name} — ${cmsMeta.tenant_name}`
                  : APPS.cms.display_name
              }
              description={APPS.cms.tagline}
              url={cmsMeta?.fallback_url ?? 'https://cms.app.veridian.site'}
              icon="FileText"
              badge="BETA"
              features={[
                'CMS multi-tenant (Payload)',
                'Édition pages site vitrine',
                'Upload assets / medias',
                'Preview avant publication',
              ]}
            />
          ) : (
            <ShadowAppCard app={APPS.cms} />
          )}
        </div>
      </section>

      <Card className="mt-12 bg-muted/50 border-muted">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Comment ça marche</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong>Démarrage à la demande :</strong> chaque app est
            provisionnée quand tu cliques &ldquo;Commencer l&apos;essai&rdquo;.
            Tu peux n&apos;activer que ce dont tu as besoin.
          </p>
          <p>
            <strong>Notifuse :</strong> magic link auto-login généré à la volée
            par le Hub (TTL 60s). Pas de mot de passe à gérer côté Notifuse.
          </p>
          <p>
            <strong>Prospection :</strong> lien sécurisé one-shot, session
            longue durée côté app pour ne pas avoir à re-cliquer chaque jour.
          </p>
          <p className="mt-4 text-xs">
            Sécurité : tous les accès passent par le Hub. Les apps downstream
            ne stockent aucun mot de passe — l&apos;authentification se fait
            par lien magique.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
