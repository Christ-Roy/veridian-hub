import { redirect } from 'next/navigation';
import { SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/app-sidebar';
import { FreemiumBanner } from '@/components/dashboard/FreemiumBanner';
import { Suspense } from 'react';
import { AuthTracker } from '@/components/analytics/auth-tracker';
import { PurchaseTracker } from '@/components/analytics/purchase-tracker';

import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { isPlatformAdmin } from '@/lib/admin/check-admin';
import { prisma } from '@/lib/prisma';
import { resolveTrialBannerState } from '@/lib/trial/banner-state';

/**
 * Récupère les lignes `tenant_trials` brutes du user.
 *
 * `tenant_trials` a une clé `(tenantId, app)` sans relation Prisma vers
 * `Tenant`/`User` — on résout donc en 2 reads : les tenants du user, puis
 * leurs lignes de trial. Tout échec DB → tableau vide (pas de bandeau plutôt
 * qu'un crash du dashboard). L'agrégation en une phase d'affichage est faite
 * par `resolveTrialBannerState` côté appelant (qui croise aussi l'état
 * subscription).
 */
async function fetchTrialRows(userUuidValue: string) {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { userId: userUuidValue, deletedAt: null },
      select: { id: true },
    });
    if (tenants.length === 0) return [];
    return await prisma.tenantTrial.findMany({
      where: { tenantId: { in: tenants.map((t) => t.id) } },
      select: { state: true },
    });
  } catch (err) {
    console.error('[Dashboard Layout] Failed to fetch trial rows:', err);
    return [];
  }
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Auth Auth.js v5 — Prisma. Pas d'appel Supabase ici.
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  // PERF (fix N+1 du 2026-05-21, étendu 2026-05-22) : reads indépendants
  // parallélisés via Promise.all. `fetchTrialRows` fait lui-même 2 reads
  // séquentiels (tenants → tenant_trials) car `tenant_trials` n'a pas de
  // relation Prisma — mais ces 2 reads tournent en parallèle des 3 autres.
  // CONTRAT IDs : subscriptions.user_id et tenants.user_id sont en UUID →
  // userUuid(user). Legacy sans workspace → null sans crasher.
  const [dbUser, workspace, subscription, trialRows] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { name: true, image: true },
    }),
    prisma.workspace
      .findFirst({
        where: {
          members: { some: { userId: user.id } },
          deletedAt: null,
        },
        select: { name: true },
      })
      .catch((err) => {
        console.error('[Dashboard Layout] Failed to fetch workspace name:', err);
        return null;
      }),
    prisma.subscription
      .findFirst({
        where: {
          userId: userUuid(user),
          status: { in: ['trialing', 'active'] },
        },
        select: { id: true, status: true },
      })
      .catch((err) => {
        console.error('[Dashboard Layout] Failed to fetch subscription:', err);
        return null;
      }),
    fetchTrialRows(userUuid(user)),
  ]);

  const currentWorkspaceName = workspace?.name ?? null;
  const hasActiveSubscription = !!subscription;

  // Phase trial à afficher dans le bandeau. `null` = aucun bandeau (phases
  // silencieuses du flow trial : signup → 5e mail → J+2, cf
  // `docs/PRICING-VERIDIAN.md`). Le bandeau n'apparaît qu'à partir de la
  // révélation du trial (state machine en `trial_active`+).
  const trialBanner = resolveTrialBannerState(trialRows, hasActiveSubscription);

  // initialIsAdmin sera passé en prop dès que AppSidebar/NavUser l'acceptent
  // (LOT C). Pour l'instant on calcule la valeur côté serveur — utile à terme
  // pour passer au sidebar et éviter qu'il refasse un fetch côté client.
  const _initialIsAdmin = isPlatformAdmin(user);
  void _initialIsAdmin;

  return (
    <SidebarProvider>
      {/* Track auth events (signup/login) et set user_id */}
      <Suspense fallback={null}>
        <AuthTracker />
      </Suspense>

      {/* Track purchase events après checkout Stripe */}
      <Suspense fallback={null}>
        <PurchaseTracker />
      </Suspense>

      <div className="flex h-screen w-full">
        <AppSidebar
          user={{
            name: dbUser?.name || user.name || user.email?.split('@')[0] || 'User',
            email: user.email || 'user@example.com',
            avatar: dbUser?.image || user.image || '/avatars/default.svg',
          }}
          workspaceName={currentWorkspaceName}
        />
        <main className="flex-1 flex flex-col overflow-hidden w-full">
          {/* Bandeau trial — rendu seulement si la state machine a révélé le
              trial (phase 4+). En phases silencieuses trialBanner === null. */}
          {trialBanner && <FreemiumBanner phase={trialBanner.phase} />}
          <div className="flex-1 overflow-auto">{children}</div>
        </main>
      </div>
    </SidebarProvider>
  );
}
