import { redirect } from 'next/navigation';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { AlertCircle, CheckCircle2, Clock, XCircle, FileText } from 'lucide-react';
import { StripePortalButton } from './StripePortalButton';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

export default async function BillingPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  // Récupérer TOUTES les subscriptions de l'utilisateur (pas juste active/trialing)
  const subscriptions = await prisma.subscription.findMany({
    where: { userId: userUuid(user) },
    orderBy: { createdAt: 'desc' },
    include: {
      price: {
        include: { product: true },
      },
    },
  });

  // Trouver la subscription active (trialing, active, ou past_due)
  const activeSubscription = subscriptions.find((s) =>
    ['trialing', 'active', 'past_due'].includes(s.status)
  );
  const subscription = activeSubscription || subscriptions[0] || null;

  // Helper pour obtenir le badge de statut. Chaque statut Stripe est mappé sur
  // un variant sémantique du Badge shadcn (tokens OKLCH) — pas de couleur brute.
  const getStatusBadge = (status: string) => {
    const statusConfig: Record<
      string,
      { label: string; variant: NonNullable<BadgeProps['variant']>; icon: typeof CheckCircle2 }
    > = {
      active: { label: 'Active', variant: 'success', icon: CheckCircle2 },
      trialing: { label: 'Trial', variant: 'info', icon: Clock },
      past_due: { label: 'Past Due', variant: 'warning', icon: AlertCircle },
      canceled: { label: 'Canceled', variant: 'outline', icon: XCircle },
      incomplete: { label: 'Incomplete', variant: 'outline', icon: AlertCircle },
      incomplete_expired: { label: 'Expired', variant: 'outline', icon: XCircle },
      unpaid: { label: 'Unpaid', variant: 'destructive', icon: XCircle },
    };

    const config = statusConfig[status] || statusConfig.incomplete;
    const Icon = config.icon;

    return (
      <Badge variant={config.variant}>
        <Icon className="w-3 h-3 mr-1" />
        {config.label}
      </Badge>
    );
  };

  // BigInt -> Number safe (pour affichage / sérialisation)
  const unitAmount = subscription?.price?.unitAmount
    ? Number(subscription.price.unitAmount)
    : 0;

  return (
    <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
      <DashboardPageHeader
        title="Billing"
        description="Manage your subscription and payment methods"
        icon={FileText}
      />

      {/* Billing Info */}
      <div className="grid gap-6">
        {/* Current Plan Card */}
        <Card>
          <CardHeader>
            <CardTitle>Current Plan</CardTitle>
            <CardDescription>
              {subscription
                ? `You are currently on the ${subscription.price?.product?.name ?? 'unknown'} plan.`
                : 'You are not currently subscribed to any plan.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {subscription ? (
              <div className="space-y-4">
                {/* Prix et période */}
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold">
                    {new Intl.NumberFormat('fr-FR', {
                      style: 'currency',
                      currency: (subscription.price?.currency || 'EUR').toUpperCase(),
                      minimumFractionDigits: 0,
                    }).format(unitAmount / 100)}
                  </span>
                  <span className="text-muted-foreground">
                    / {subscription.price?.interval}
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

                  {subscription.currentPeriodEnd && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Current period ends:</span>
                      <span className="font-medium">{new Date(subscription.currentPeriodEnd).toLocaleDateString()}</span>
                    </div>
                  )}

                  {subscription.trialEnd && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Trial ends:</span>
                      <span className="font-medium">{new Date(subscription.trialEnd).toLocaleDateString()}</span>
                    </div>
                  )}

                  {subscription.cancelAt && (
                    <div className="flex justify-between text-destructive">
                      <span>Cancels on:</span>
                      <span className="font-medium">{new Date(subscription.cancelAt).toLocaleDateString()}</span>
                    </div>
                  )}

                  {subscription.canceledAt && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Canceled on:</span>
                      <span>{new Date(subscription.canceledAt).toLocaleDateString()}</span>
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
                  View pricing plans
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
                  <span className="text-xs">{subscription?.stripeCustomerId || 'Not created yet'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Subscriptions:</span>
                  <span>{subscriptions.length}</span>
                </div>
                {subscription?.stripeSubscriptionId && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Stripe Subscription ID:</span>
                    <span className="text-xs">{subscription.stripeSubscriptionId}</span>
                  </div>
                )}
                {subscription?.priceId && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Price ID:</span>
                    <span className="text-xs">{subscription.priceId}</span>
                  </div>
                )}
              </div>

              {subscriptions.length === 0 && (
                <Alert variant="info" className="mt-4">
                  <AlertDescription>
                    <p className="text-sm">No subscriptions found. This could mean:</p>
                    <ul className="text-xs mt-2 ml-4 list-disc space-y-1">
                      <li>You haven't subscribed yet</li>
                      <li>Webhook hasn't synced yet (check /api/webhooks logs)</li>
                      <li>Stripe webhook is not configured</li>
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        )}

        {/* Info */}
        <div className="rounded-lg border bg-muted/50 p-4">
          <p className="text-sm text-muted-foreground">
            All billing is securely managed by Stripe. You can update your payment method,
            view invoices, and manage your subscription in the customer portal.
          </p>
        </div>
      </div>
    </div>
  );
}
