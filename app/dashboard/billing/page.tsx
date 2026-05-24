import { redirect } from 'next/navigation';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { FileText } from 'lucide-react';
import { StripePortalButton } from './StripePortalButton';
import { BillingStatusAlert } from './BillingStatusAlert';
import { EmptyBillingState } from './EmptyBillingState';
import { SubscriptionCard, type SubscriptionView } from './SubscriptionCard';
import { RecentInvoicesCard } from './RecentInvoicesCard';
import { RefillPromoCard } from './RefillPromoCard';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { getRecentInvoices } from '@/lib/stripe/invoices';

export default async function BillingPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  // Toutes les subscriptions du user (pas seulement active/trialing) — il faut
  // pouvoir afficher l'état d'une sub `canceled` / `past_due`.
  const subscriptions = await prisma.subscription.findMany({
    where: { userId: userUuid(user) },
    orderBy: { createdAt: 'desc' },
    include: {
      price: {
        include: { product: true },
      },
    },
  });

  // Tenant Prospection provisionne (cle pour afficher panel refill leads).
  // Schema Hub n'embarque pas leadsBalance, donc on n'affiche pas de chiffre —
  // juste la presence d'un tenant Prospection actif gate l'affichage du panel.
  const prospectionTenant = await prisma.tenant.findFirst({
    where: {
      userId: userUuid(user),
      deletedAt: null,
      prospectionProvisionedAt: { not: null },
    },
    select: { id: true },
  });

  // Customer Stripe (pour lister factures). On lit le 1er id non-null dispose
  // sur les subscriptions du user — meme Customer pour toutes les subs en
  // pratique.
  const stripeCustomerId =
    subscriptions.find((s) => s.stripeCustomerId)?.stripeCustomerId ?? null;
  const invoices = await getRecentInvoices(stripeCustomerId, 3);

  // Subscription "vivante" prioritaire ; à défaut la plus récente (utile pour
  // montrer un état `canceled` avec son CTA réactiver).
  const liveSubscription = subscriptions.find((s) =>
    ['trialing', 'active', 'past_due'].includes(s.status)
  );
  const subscription = liveSubscription || subscriptions[0] || null;

  // Sérialisation pour la carte d'affichage : on résout BigInt (montant) et
  // Date côté serveur — `SubscriptionCard` ne touche ni Prisma ni Stripe.
  const subscriptionView: SubscriptionView | null = subscription
    ? {
        status: subscription.status,
        planName:
          subscription.price?.product?.name ??
          subscription.planName ??
          'Abonnement',
        unitAmount: subscription.price?.unitAmount
          ? Number(subscription.price.unitAmount)
          : 0,
        currency: subscription.price?.currency ?? 'EUR',
        interval: subscription.price?.interval ?? null,
        currentPeriodEnd:
          subscription.currentPeriodEnd?.toISOString() ?? null,
        trialEnd: subscription.trialEnd?.toISOString() ?? null,
        // Annulation : `cancelAt` si programmée, sinon `currentPeriodEnd`
        // quand la sub est déjà `canceled` (= jusqu'à quand l'accès reste).
        cancelAt:
          subscription.cancelAt?.toISOString() ??
          (subscription.status === 'canceled'
            ? subscription.currentPeriodEnd?.toISOString() ?? null
            : null),
      }
    : null;

  return (
    <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
      <DashboardPageHeader
        title="Facturation"
        description="Gère ton abonnement et tes moyens de paiement"
        icon={FileText}
      />

      {/* Alerte de tête de page : dunning (past_due) ou annulation (canceled).
          Rend `null` pour les états sains. */}
      {subscription && <BillingStatusAlert status={subscription.status} />}

      <div className="grid gap-6">
        {/* Carte plan actuel */}
        <Card>
          <CardHeader>
            <CardTitle>Mon abonnement</CardTitle>
            <CardDescription>
              {subscriptionView
                ? 'Le détail de ta formule Veridian.'
                : 'Tu n’as pas encore d’abonnement actif.'}
            </CardDescription>
          </CardHeader>
          {subscriptionView ? (
            <SubscriptionCard subscription={subscriptionView} />
          ) : (
            <CardContent>
              <EmptyBillingState />
            </CardContent>
          )}
        </Card>

        {/* Portail Stripe — visible dès qu'une subscription existe (même
            canceled : permet de récupérer ses factures). */}
        {subscription && (
          <Card>
            <CardHeader>
              <CardTitle>Gérer mon abonnement</CardTitle>
              <CardDescription>
                Mets à jour ta carte, télécharge tes factures ou résilie ton
                abonnement.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  Tout est géré en toute sécurité par Stripe.
                </p>
                <StripePortalButton label="Gérer mon abonnement" />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Factures recentes (rend null si liste vide) */}
        <RecentInvoicesCard invoices={invoices} />

        {/* Acheter des leads — gated sur tenant Prospection */}
        {prospectionTenant && <RefillPromoCard />}

        {/* Note de réassurance */}
        <Card className="bg-muted/50 border-muted">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">
              La facturation est gérée de façon sécurisée par Stripe. Tu peux
              modifier ton moyen de paiement, consulter tes factures et gérer ton
              abonnement depuis le portail client.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
