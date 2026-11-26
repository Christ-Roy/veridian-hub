import { isEmailProvenForSession } from '@/lib/auth/email-proof';
import { EmailProofBanner } from './components/EmailProofBanner';
import { redirect } from 'next/navigation';
import { TenantCard } from './components/TenantCard';
import { ProspectionCard } from './components/ProspectionCard';
import { ServiceCard } from './components/ServiceCard';
import { ShadowAppCard } from './components/ShadowAppCard';
import { OutilsOrganisation } from './components/OutilsOrganisation';
import { OnboardingChecklist } from './components/OnboardingChecklist';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { LayoutDashboard } from 'lucide-react';
import { fermeesIci, PAGE_ORGANISATION } from '@/lib/federation/session';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { APPS } from '@/lib/pricing/plans';
import { getEnabledGatedApps } from '@/lib/tenant-apps';
import { lienApp } from '@/lib/apps/lien-app';
import { montrerInclusAvecSite } from '@/lib/apps/inclus-avec-site';
import { organisationsSeules } from '@/lib/tenants/membre-seul';
import { resolveAnalyticsCardTarget } from '@/lib/analytics/dashboard-target';
import { idEspaceMeta } from '@/lib/apps/espace-note';
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
 *    - Prospection : rebond signé du Hub
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
  // Le layout ne rejoue pas à chaque navigation : la garde est aussi ici.
  if ((await fermeesIci(user)).some((f) => f.proprietaire)) redirect(PAGE_ORGANISATION);

  const params = await searchParams;
  const showDebug = process.env.NODE_ENV === 'development' && params.debug === '1';

  // Apps GATED activées pour ce tenant (twenty/CRM, analytics, cms) — pilotées
  // par Robert via l'Admin API. Défaut OFF : sans activation explicite, ces
  // cards restent en mode "Bientôt" (ShadowAppCard). Prospection + Notifuse
  // ne sont PAS concernés (toujours grand public). Lecture par UUID bridge.
  const enabledApps = await getEnabledGatedApps(prisma, userUuid(user));
  // Le CRM est ouvert à tout compte : la première ouverture crée l'espace (rebond, ensureCrmWorkspace).
  const crmUrl = process.env.CRM_API_URL;
  const isTwentyEnabled = !!crmUrl;
  const isAnalyticsEnabled = enabledApps.has('analytics');
  const isCmsEnabled = enabledApps.has('cms');
  // Academy est réservée : sa tuile n'existe que pour un compte activé (Robert seul, 22/11).
  const academyUrl = process.env.ACADEMY_API_URL;
  const isAcademyEnabled = enabledApps.has('academy') && !!academyUrl;

  // Un salarié, sans espace à lui : les apps de son organisation, aucun essai à démarrer.
  const organisations = await organisationsSeules(prisma, userUuid(user)).catch(() => []);
  if (organisations.length > 0) {
    return (
      <div className="container mx-auto p-4 sm:p-6 lg:p-8 max-w-6xl">
        <DashboardPageHeader title="Vos outils" description="Les applications ouvertes par votre organisation" icon={LayoutDashboard} className="mb-8" />
        {!(await isEmailProvenForSession(user.id)) && user.email && <EmailProofBanner email={user.email} />}
        <OutilsOrganisation organisations={organisations} academyActivee={isAcademyEnabled} />
      </div>
    );
  }

  const tenant = await prisma.tenant.findFirst({
    where: { userId: userUuid(user), deletedAt: null },
    select: {
      id: true,
      name: true,
      status: true,
      notifuseWorkspaceSlug: true,
      notifuseInvitationSentAt: true,
      notifusePlan: true,
      prospectionProvisionedAt: true,
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
  // NB : `showActiveAnalytics` est complété plus bas par la découverte — si
  // l'app d'analytics reconnaît cet email et lui donne au moins un site, la
  // carte s'affiche même sans activation manuelle. Un client qui a un site
  // doit le voir ; l'inverse était un oubli d'activation silencieux.
  // Un espace Analytics noté (provisionnement, `hub link`) suffit : sans site, le client doit pouvoir entrer (parente, 26/11).
  const showActiveAnalyticsBase =
    isAnalyticsEnabled || hasLifetimeSiteVitrine || hasServiceAnalytics || !!idEspaceMeta(tenant?.metadata, 'analytics');
  const showActiveCms = isCmsEnabled || hasLifetimeSiteVitrine || hasServiceCms;

  const emailProven = await isEmailProvenForSession(user.id);
  // Cible de la carte Analytics. On demande à l'app d'analytics quels sites
  // CET email peut ouvrir, plutôt que de relire une URL figée au provisioning.
  // Un seul site → on y emmène le client directement ; plusieurs → la racine.
  // Découverte muette ou non câblée → on retombe sur l'ancien comportement.
  // Cf. `lib/analytics/dashboard-target.ts` pour le raisonnement complet.
  const analyticsTarget = await resolveAnalyticsCardTarget({
    // Adresse non prouvée : on ne demande rien, sinon la carte révélerait les sites d'un tiers.
    email: emailProven ? user.email : null,
    hubUserId: emailProven ? userUuid(user) : null,
    metadataFallbackUrl: analyticsMeta?.fallback_url,
    metadataTenantName: analyticsMeta?.tenant_name,
  });
  const showActiveAnalytics =
    showActiveAnalyticsBase || analyticsTarget.siteCount > 0;

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
        {!emailProven && user.email && <EmailProofBanner email={user.email} />}
        <div className="mb-4">
          <h2 className="text-2xl font-semibold tracking-tight">Vos outils</h2>
          <p className="text-sm text-muted-foreground">
            Activez les outils qui vous intéressent, chacun de façon indépendante.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <ProspectionCard
            configured={!!tenant?.prospectionProvisionedAt}
            url={lienApp('prospection')}
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
                analyticsTarget.siteName
                  ? `${APPS.analytics.display_name} — ${analyticsTarget.siteName}`
                  : APPS.analytics.display_name
              }
              description={APPS.analytics.tagline}
              url={analyticsTarget.url}
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
          {isTwentyEnabled && crmUrl && (
            <ServiceCard
              name="Veridian CRM"
              description="Vos contacts, sociétés et affaires au même endroit."
              url={crmUrl}
              icon="Users"
              appKey="crm"
              badge="BETA"
              features={[
                'Contacts, sociétés et opportunités',
                'Vues, filtres et tableaux de bord',
                'Automatisations sans code',
                'Accès API et MCP pour vos outils',
              ]}
            />
          )}
          {isAcademyEnabled && academyUrl && (
            <ServiceCard
              name="Veridian Academy"
              description="Vos formations en ligne, prêtes à suivre."
              url={academyUrl}
              icon="GraduationCap"
              appKey="academy"
              badge="BETA"
              features={[
                'Parcours de formation guidés',
                'Leçons courtes et pratiques',
                'Suivi de votre progression',
                'Accès MCP pour votre assistant IA',
              ]}
            />
          )}
        </div>
      </section>

      {/* Section "Inclus avec votre site web" : uniquement les services pas
          encore activés (les actifs ont remonté dans "Vos outils"). Masquée
          si tout est déjà activé, et chez qui n'a pas de site (VER-105). */}
      {montrerInclusAvecSite({ plan: hasLifetimeSiteVitrine, analytics: showActiveAnalytics, cms: showActiveCms }) && (
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
