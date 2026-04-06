import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { FreemiumBanner } from "@/components/dashboard/FreemiumBanner";
import { AuthTracker } from "@/components/analytics/auth-tracker";
import { PurchaseTracker } from "@/components/analytics/purchase-tracker";
import { clearUserId } from "@/lib/gtm";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Vérifier l'authentification
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Rediriger vers login si non authentifié
  if (!user) {
    redirect('/login');
  }

  // Récupérer la date de création de l'utilisateur
  // Note: auth.users.created_at est disponible via user.created_at
  const userCreatedAt = user.created_at;

  // Vérifier si l'utilisateur a une subscription active (trialing ou active)
  const { data: subscription, error: subError } = await supabase
    .from('subscriptions')
    .select('id, status')
    .eq('user_id', user.id)
    .in('status', ['trialing', 'active'])
    .maybeSingle();

  const hasActiveSubscription = !!subscription;

  // Logs de debug en dev
  if (process.env.NODE_ENV === 'development') {
    console.log('[Dashboard Layout] User info:', {
      userId: user.id,
      email: user.email,
      createdAt: userCreatedAt,
      hasActiveSubscription,
      subscription: subscription ? { id: (subscription as any).id, status: (subscription as any).status } : null,
      subError: subError?.message
    });
  }

  return (
    <SidebarProvider>
      {/* Track auth events (signup/login) et set user_id */}
      <AuthTracker />

      {/* Track purchase events après checkout Stripe */}
      <PurchaseTracker />

      <div className="flex h-screen w-full">
        <AppSidebar
          user={{
            name: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'User',
            email: user.email || 'user@example.com',
            avatar: user.user_metadata?.avatar_url || '/avatars/default.svg',
          }}
        />
        <main className="flex-1 flex flex-col overflow-hidden w-full">
          {/* Bandeau freemium - à l'intérieur du main content */}
          <FreemiumBanner
            userCreatedAt={userCreatedAt}
            hasActiveSubscription={hasActiveSubscription}
          />
          <div className="flex-1 overflow-auto">
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
