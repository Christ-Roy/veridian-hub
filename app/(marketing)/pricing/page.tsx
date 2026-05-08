import { Metadata } from 'next';
import Pricing from '@/components/ui/Pricing/Pricing';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

export const metadata: Metadata = {
  title: 'Tarifs flexibles pour Twenty CRM & Notifuse',
  description: 'Découvrez les offres Veridian. Des tarifs transparents pour centraliser votre CRM et votre marketing. Commencez gratuitement dès aujourd\'hui !',
  openGraph: {
    title: 'Tarifs Veridian | Plans flexibles pour Twenty & Notifuse',
    description: 'Découvrez les offres Veridian. Des tarifs transparents pour centraliser votre CRM et votre marketing. Commencez gratuitement dès aujourd\'hui !'
  }
};

/**
 * PAGE PRICING - Affiche les plans d'abonnement Stripe
 *
 * Architecture (Auth.js + Prisma) :
 * - Server Component
 * - Récupère user via getCurrentUser() (Auth.js v5)
 * - Récupère products + prices via Prisma (table hub_app.products / .prices)
 * - Récupère subscription active via Prisma
 * - Sérialise BigInt -> Number AVANT de passer au Client Component (sinon plante)
 */

// Génère le JSON-LD dynamiquement à partir des produits Stripe
function generateJsonLd(products: SerializedProductWithPrices[]) {
  // Extraire les prix mensuels pour le schema
  const monthlyPrices = products
    .flatMap((p) => p.prices?.filter((price) => price.interval === 'month') || [])
    .map((price) => (price.unit_amount || 0) / 100)
    .sort((a, b) => a - b);

  const offers = products.map((product) => {
    const monthlyPrice = product.prices?.find((p) => p.interval === 'month');
    return {
      '@type': 'Offer',
      name: product.name,
      price: monthlyPrice ? String((monthlyPrice.unit_amount || 0) / 100) : '0',
      priceCurrency: monthlyPrice?.currency?.toUpperCase() || 'EUR',
      description: product.description || `Plan ${product.name} Veridian`
    };
  });

  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Veridian',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: 'Plateforme SaaS tout-en-un intégrant Twenty CRM et Notifuse pour centraliser la gestion client et l\'automatisation marketing.',
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'EUR',
      lowPrice: String(monthlyPrices[0] || 0),
      highPrice: String(monthlyPrices[monthlyPrices.length - 1] || 99),
      offerCount: String(products.length),
      offers
    }
  };
}

// Type sérialisé (BigInt -> Number) pour passage Server -> Client.
// Volontairement compatible avec l'ancien `Tables<'prices'>` au runtime.
export interface SerializedPrice {
  id: string;
  product_id: string | null;
  active: boolean | null;
  description: string | null;
  unit_amount: number | null;
  currency: string | null;
  type: string | null;
  interval: string | null;
  interval_count: number | null;
  trial_period_days: number | null;
  metadata: any;
  products?: SerializedProduct | null;
}
export interface SerializedProduct {
  id: string;
  active: boolean | null;
  name: string | null;
  description: string | null;
  image: string | null;
  metadata: any;
}
export interface SerializedProductWithPrices extends SerializedProduct {
  prices: SerializedPrice[];
}
export interface SerializedSubscription {
  id: string;
  user_id: string;
  status: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  price_id: string | null;
  trial_end: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  canceled_at: string | null;
  created: string | null;
  prices: SerializedPrice | null;
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; interval?: string; redirect?: string }>;
}) {
  const user = await getCurrentUser();

  // Products + Prices actifs
  const productsRaw = await prisma.product.findMany({
    where: { active: true },
    include: {
      prices: { where: { active: true } },
    },
  });

  // Subscription active du user (si loggé)
  let subscriptionRaw: any = null;
  if (user) {
    try {
      subscriptionRaw = await prisma.subscription.findFirst({
        where: {
          userId: userUuid(user),
          status: { in: ['trialing', 'active'] },
        },
        include: {
          price: {
            include: { product: true },
          },
        },
      });
    } catch (err) {
      console.warn('[Pricing] Subscription lookup failed:', err);
    }
  }

  // Sérialisation BigInt -> Number + remap snake_case attendu par Pricing.tsx
  const products: SerializedProductWithPrices[] = productsRaw.map((p) => ({
    id: p.id,
    active: p.active,
    name: p.name,
    description: p.description,
    image: p.image,
    metadata: p.metadata,
    prices: p.prices.map((pr) => ({
      id: pr.id,
      product_id: pr.productId,
      active: pr.active,
      description: pr.description,
      unit_amount: pr.unitAmount === null ? null : Number(pr.unitAmount),
      currency: pr.currency,
      type: pr.type,
      interval: pr.interval,
      interval_count: pr.intervalCount,
      trial_period_days: pr.trialPeriodDays,
      metadata: pr.metadata,
    })),
  }));

  let subscription: SerializedSubscription | null = null;
  if (subscriptionRaw) {
    subscription = {
      id: subscriptionRaw.id,
      user_id: subscriptionRaw.userId,
      status: subscriptionRaw.status,
      stripe_customer_id: subscriptionRaw.stripeCustomerId,
      stripe_subscription_id: subscriptionRaw.stripeSubscriptionId,
      stripe_price_id: subscriptionRaw.stripePriceId,
      price_id: subscriptionRaw.priceId,
      trial_end: subscriptionRaw.trialEnd?.toISOString() ?? null,
      current_period_end: subscriptionRaw.currentPeriodEnd?.toISOString() ?? null,
      cancel_at: subscriptionRaw.cancelAt?.toISOString() ?? null,
      canceled_at: subscriptionRaw.canceledAt?.toISOString() ?? null,
      created: subscriptionRaw.created?.toISOString() ?? null,
      prices: subscriptionRaw.price
        ? {
            id: subscriptionRaw.price.id,
            product_id: subscriptionRaw.price.productId,
            active: subscriptionRaw.price.active,
            description: subscriptionRaw.price.description,
            unit_amount:
              subscriptionRaw.price.unitAmount === null
                ? null
                : Number(subscriptionRaw.price.unitAmount),
            currency: subscriptionRaw.price.currency,
            type: subscriptionRaw.price.type,
            interval: subscriptionRaw.price.interval,
            interval_count: subscriptionRaw.price.intervalCount,
            trial_period_days: subscriptionRaw.price.trialPeriodDays,
            metadata: subscriptionRaw.price.metadata,
            products: subscriptionRaw.price.product
              ? {
                  id: subscriptionRaw.price.product.id,
                  active: subscriptionRaw.price.product.active,
                  name: subscriptionRaw.price.product.name,
                  description: subscriptionRaw.price.product.description,
                  image: subscriptionRaw.price.product.image,
                  metadata: subscriptionRaw.price.product.metadata,
                }
              : null,
          }
        : null,
    };
  }

  const params = await searchParams;
  const jsonLd = generateJsonLd(products);

  // Pour le composant Pricing.tsx (legacy types Supabase) on passe `null` si
  // pas de user. Les seuls champs utilisés sont email/id, qu'on mappe.
  const pricingUser = user
    ? { id: user.id, email: user.email, user_metadata: {} as any }
    : null;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Pricing
        user={pricingUser as any}
        products={products as any}
        subscription={subscription as any}
        currentPath="/pricing"
        preselectedPlan={params.plan}
        preselectedInterval={params.interval as 'month' | 'year' | undefined}
        successRedirect={params.redirect}
      />
    </>
  );
}
