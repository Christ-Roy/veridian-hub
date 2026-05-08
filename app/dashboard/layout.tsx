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

  // Récupérer la date de création + nom (Prisma) — `getCurrentUser` ne sélectionne
  // que id/email/name/image/supabaseUserId, donc on refait un find pour
  // createdAt qui sert à la bannière freemium.
  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { createdAt: true, name: true, image: true },
  });

  const userCreatedAt = dbUser?.createdAt?.toISOString() ?? new Date().toISOString();

  // Vérifier si l'utilisateur a une subscription active.
  // CONTRAT IDs : subscriptions.user_id est en UUID — on utilise userUuid().
  let hasActiveSubscription = false;
  try {
    const sub = await prisma.subscription.findFirst({
      where: {
        userId: userUuid(user),
        status: { in: ['trialing', 'active'] },
      },
      select: { id: true, status: true },
    });
    hasActiveSubscription = !!sub;

    if (process.env.NODE_ENV === 'development') {
      console.log('[Dashboard Layout] User info:', {
        userId: user.id,
        email: user.email,
        createdAt: userCreatedAt,
        hasActiveSubscription,
        subscription: sub ? { id: sub.id, status: sub.status } : null,
      });
    }
  } catch (err) {
    console.error('[Dashboard Layout] Failed to fetch subscription:', err);
  }

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
        />
        <main className="flex-1 flex flex-col overflow-hidden w-full">
          {/* Bandeau freemium - à l'intérieur du main content */}
          <FreemiumBanner
            userCreatedAt={userCreatedAt}
            hasActiveSubscription={hasActiveSubscription}
          />
          <div className="flex-1 overflow-auto">{children}</div>
        </main>
      </div>
    </SidebarProvider>
  );
}
