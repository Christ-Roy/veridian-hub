import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, CheckCircle2, Clock, XCircle, FileText } from 'lucide-react';
import { StripePortalButton } from './StripePortalButton';

export default async function BillingPage() {
  const supabase = createClient();

  // 🔒 Auth check
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Récupérer TOUTES les subscriptions de l'utilisateur (pas juste active/trialing)
  const { data: subscriptions, error: subsError } = await supabase
    .from('subscriptions')
    .select(`
      *,
      prices(
        *,
        products(*)
      )
    `)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  // Récupérer les infos customer Stripe
  const { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('id', user.id)
    .maybeSingle() as { data: { id: string; stripe_customer_id: string | null } | null };

  // Trouver la subscription active (trialing, active, ou past_due)
  const activeSubscription = subscriptions?.find((s: any) =>
    ['trialing', 'active', 'past_due'].includes(s.status)
  );

  // S'il n'y a pas de subscription active, prendre la plus récente
  const subscription: any = activeSubscription || subscriptions?.[0] || null;

  // Helper pour obtenir le badge de statut
  const getStatusBadge = (status: string) => {
    const statusConfig = {
      active: { label: 'Active', variant: 'default' as const, icon: CheckCircle2, className: 'bg-green-500' },
      trialing: { label: 'Trial', variant: 'secondary' as const, icon: Clock, className: 'bg-blue-500' },
      past_due: { label: 'Past Due', variant: 'destructive' as const, icon: AlertCircle, className: 'bg-orange-500' },
      canceled: { label: 'Canceled', variant: 'outline' as const, icon: XCircle, className: 'bg-gray-500' },
      incomplete: { label: 'Incomplete', variant: 'outline' as const, icon: AlertCircle, className: 'bg-yellow-500' },
      incomplete_expired: { label: 'Expired', variant: 'outline' as const, icon: XCircle, className: 'bg-red-500' },
      unpaid: { label: 'Unpaid', variant: 'destructive' as const, icon: XCircle, className: 'bg-red-600' },
    };

    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.incomplete;
    const Icon = config.icon;

    return (
      <Badge variant={config.variant} className={`${config.className} text-white`}>
        <Icon className="w-3 h-3 mr-1" />
        {config.label}
      </Badge>
    );
  };

  return (
    <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <FileText className="h-10 w-10 text-primary" />
          <h1 className="text-4xl font-bold tracking-tight">Billing</h1>
        </div>
        <p className="text-muted-foreground">
          Manage your subscription and payment methods
        </p>
      </div>

      {/* Billing Info */}
      <div className="grid gap-6">
        {/* Current Plan Card */}
        <Card>
          <CardHeader>
            <CardTitle>Current Plan</CardTitle>
            <CardDescription>
              {subscription
                ? `You are currently on the ${subscription?.prices?.products?.name} plan.`
                : 'You are not currently subscribed to any plan.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {subscription ? (
              <div className="space-y-4">
                {/* Prix et période */}
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold">
                    {new Intl.NumberFormat('en-US', {
                      style: 'currency',
                      currency: subscription?.prices?.currency || 'USD',
                      minimumFractionDigits: 0,
                    }).format((subscription?.prices?.unit_amount || 0) / 100)}
                  </span>
                  <span className="text-muted-foreground">
                    / {subscription?.prices?.interval}
                  </span>
                </div>

                {/* Statut avec badge */}
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Status:</span>
                  {getStatusBadge(subscription.status)}
                </div>

                {/* Informations détaillées */}
                <div className="text-sm space-y-2 pt-4 border-t">
                  {subscription.created && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Started:</span>
                      <span className="font-medium">{new Date(subscription.created).toLocaleDateString()}</span>
                    </div>
                  )}

                  {subscription.current_period_end && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Current period ends:</span>
                      <span className="font-medium">{new Date(subscription.current_period_end).toLocaleDateString()}</span>
                    </div>
                  )}

                  {subscription.trial_end && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Trial ends:</span>
                      <span className="font-medium">{new Date(subscription.trial_end).toLocaleDateString()}</span>
                    </div>
                  )}

                  {subscription.cancel_at && (
                    <div className="flex justify-between text-destructive">
                      <span>Cancels on:</span>
                      <span className="font-medium">{new Date(subscription.cancel_at).toLocaleDateString()}</span>
                    </div>
                  )}

                  {subscription.canceled_at && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Canceled on:</span>
                      <span>{new Date(subscription.canceled_at).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="py-6 text-center">
                <p className="text-muted-foreground mb-4">No active subscription</p>
                <a
                  href="/pricing"
                  className="text-primary hover:underline font-medium"
                >
                  View pricing plans →
                </a>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Stripe Portal */}
        <Card>
          <CardHeader>
            <CardTitle>Manage Subscription</CardTitle>
            <CardDescription>
              Update payment method, download invoices, or cancel your subscription
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Manage your subscription on Stripe.
              </p>
              <StripePortalButton />
            </div>
          </CardContent>
        </Card>

        {/* Debug Info - Afficher seulement en dev */}
        {process.env.NODE_ENV === 'development' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Debug Information</CardTitle>
              <CardDescription>
                Technical details for development
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm font-mono">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">User ID:</span>
                  <span className="text-xs">{user.id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Stripe Customer ID:</span>
                  <span className="text-xs">{customer?.stripe_customer_id || 'Not created yet'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Subscriptions:</span>
                  <span>{subscriptions?.length || 0}</span>
                </div>
                {subscription?.stripe_subscription_id && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Stripe Subscription ID:</span>
                    <span className="text-xs">{subscription.stripe_subscription_id}</span>
                  </div>
                )}
                {subscription?.price_id && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Price ID:</span>
                    <span className="text-xs">{subscription.price_id}</span>
                  </div>
                )}
              </div>

              {subsError && (
                <div className="mt-4 p-3 bg-destructive/10 border border-destructive rounded-md">
                  <p className="text-sm text-destructive font-medium">Error loading subscriptions:</p>
                  <p className="text-xs text-destructive/80 mt-1">{subsError.message}</p>
                </div>
              )}

              {!customer?.stripe_customer_id && (
                <div className="mt-4 p-3 bg-yellow-500/10 border border-yellow-500 rounded-md">
                  <p className="text-sm text-yellow-700 dark:text-yellow-400">
                    ⚠️ No Stripe customer created yet. Customer will be created when you subscribe to a plan.
                  </p>
                </div>
              )}

              {subscriptions && subscriptions.length === 0 && (
                <div className="mt-4 p-3 bg-blue-500/10 border border-blue-500 rounded-md">
                  <p className="text-sm text-blue-700 dark:text-blue-400">
                    ℹ️ No subscriptions found. This could mean:
                  </p>
                  <ul className="text-xs text-blue-600 dark:text-blue-300 mt-2 ml-4 list-disc space-y-1">
                    <li>You haven't subscribed yet</li>
                    <li>Webhook hasn't synced yet (check /api/webhooks logs)</li>
                    <li>Stripe webhook is not configured</li>
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Info */}
        <div className="rounded-lg border bg-muted/50 p-4">
          <p className="text-sm text-muted-foreground">
            💳 All billing is securely managed by Stripe. You can update your payment method,
            view invoices, and manage your subscription in the customer portal.
          </p>
        </div>
      </div>
    </div>
  );
}
