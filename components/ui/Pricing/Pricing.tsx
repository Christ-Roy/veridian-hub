'use client';

import { Button } from '@/components/ui/button';
import LogoCloud from '@/components/ui/LogoCloud';
import type { Tables } from '@/types_db';
import { getStripe } from '@/utils/stripe/client';
import { checkoutWithStripe, createStripePortal } from '@/utils/stripe/server';
import { getErrorRedirect } from '@/utils/helpers';
import { User } from '@supabase/supabase-js';
import cn from 'classnames';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { trackBeginCheckout, trackError } from '@/lib/gtm';

type Subscription = Tables<'subscriptions'>;
type Product = Tables<'products'>;
type Price = Tables<'prices'>;
interface ProductWithPrices extends Product {
  prices: Price[];
}
interface PriceWithProduct extends Price {
  products: Product | null;
}
interface SubscriptionWithProduct extends Subscription {
  prices: PriceWithProduct | null;
}

interface Props {
  user: User | null | undefined;
  products: ProductWithPrices[];
  subscription: SubscriptionWithProduct | null;
  currentPath?: string;
  preselectedPlan?: string;
  preselectedInterval?: 'month' | 'year';
  successRedirect?: string;
}

type BillingInterval = 'lifetime' | 'year' | 'month';

// Durée du trial depuis env (aligné avec Twenty)
const TRIAL_DAYS = parseInt(process.env.NEXT_PUBLIC_TRIAL_PERIOD_DAYS || '7', 10);

// Plan Freemium (pas de produit Stripe, trial gratuit)
const FREEMIUM_PLAN = {
  id: 'freemium',
  name: 'Freemium',
  description: `Essai gratuit de ${TRIAL_DAYS} jours. Accès complet à Twenty CRM et Notifuse.`,
  features: [
    `${TRIAL_DAYS} jours d'essai gratuit`,
    'Twenty CRM complet',
    'Notifuse Email Marketing',
    '1 utilisateur',
    'Support communautaire'
  ]
};

export default function Pricing({ user, products, subscription, currentPath = '/pricing', preselectedPlan, preselectedInterval, successRedirect }: Props) {
  const intervals = Array.from(
    new Set(
      products.flatMap((product) =>
        product?.prices?.map((price) => price?.interval)
      )
    )
  );
  const router = useRouter();
  const [billingInterval, setBillingInterval] =
    useState<BillingInterval>(preselectedInterval || 'month');
  const [priceIdLoading, setPriceIdLoading] = useState<string>();

  const handleStripeCheckout = async (price: Price) => {
    setPriceIdLoading(price.id);

    if (!user) {
      setPriceIdLoading(undefined);
      return router.push('/signup');
    }

    // Track begin_checkout event avant de créer la session Stripe
    const priceAmount = (price.unit_amount || 0) / 100;
    const productName = products.find(p =>
      p.prices?.some(pr => pr.id === price.id)
    )?.name || 'Unknown plan';

    console.log('[Pricing] Tracking begin_checkout:', {
      priceId: price.id,
      amount: priceAmount,
      product: productName
    });

    trackBeginCheckout(price.id, priceAmount, productName);

    const { errorRedirect, sessionId } = await checkoutWithStripe(
      price,
      successRedirect || currentPath
    );

    if (errorRedirect) {
      setPriceIdLoading(undefined);
      // Track error
      trackError('checkout_error', 'Stripe checkout failed: ' + errorRedirect);
      return router.push(errorRedirect);
    }

    if (!sessionId) {
      setPriceIdLoading(undefined);
      trackError('checkout_error', 'No session ID returned from Stripe');
      return router.push(
        getErrorRedirect(
          currentPath,
          'An unknown error occurred.',
          'Please try again later or contact a system administrator.'
        )
      );
    }

    const stripe = await getStripe();
    stripe?.redirectToCheckout({ sessionId });

    setPriceIdLoading(undefined);
  };

  if (!products.length) {
    return (
      <section className="bg-background">
        <div className="max-w-6xl px-4 py-8 mx-auto sm:py-24 sm:px-6 lg:px-8">
          <div className="sm:flex sm:flex-col sm:align-center"></div>
          <p className="text-4xl font-extrabold text-foreground sm:text-center sm:text-6xl">
            No subscription pricing plans found. Create them in your{' '}
            <a
              className="text-primary underline"
              href="https://dashboard.stripe.com/products"
              rel="noopener noreferrer"
              target="_blank"
            >
              Stripe Dashboard
            </a>
            .
          </p>
        </div>
        <LogoCloud />
      </section>
    );
  } else {
    return (
      <section className="bg-background">
        <div className="max-w-6xl px-4 py-8 mx-auto sm:py-24 sm:px-6 lg:px-8">
          <div className="sm:flex sm:flex-col sm:align-center">
            <h1 className="text-4xl font-extrabold text-foreground sm:text-center sm:text-6xl">
              Choisissez votre plan Veridian
            </h1>
            <p className="max-w-2xl m-auto mt-5 text-xl text-muted-foreground200 sm:text-center sm:text-2xl">
              Des tarifs transparents pour centraliser votre CRM et votre marketing.
              Commencez gratuitement, évoluez selon vos besoins.
            </p>
            <div className="relative self-center mt-6 bg-card rounded-lg p-0.5 flex sm:mt-8 border border-border">
              {intervals.includes('month') && (
                <button
                  onClick={() => setBillingInterval('month')}
                  type="button"
                  className={`${
                    billingInterval === 'month'
                      ? 'relative w-1/2 bg-accent border-border shadow-sm text-foreground'
                      : 'ml-0.5 relative w-1/2 border border-transparent text-muted-foreground/60'
                  } rounded-md m-1 py-2 text-sm font-medium whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-ring focus:ring-opacity-50 focus:z-10 sm:w-auto sm:px-8`}
                >
                  Monthly billing
                </button>
              )}
              {intervals.includes('year') && (
                <button
                  onClick={() => setBillingInterval('year')}
                  type="button"
                  className={`${
                    billingInterval === 'year'
                      ? 'relative w-1/2 bg-accent border-border shadow-sm text-foreground'
                      : 'ml-0.5 relative w-1/2 border border-transparent text-muted-foreground/60'
                  } rounded-md m-1 py-2 text-sm font-medium whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-ring focus:ring-opacity-50 focus:z-10 sm:w-auto sm:px-8`}
                >
                  Yearly billing
                </button>
              )}
            </div>
          </div>
          <div className="mt-12 space-y-0 sm:mt-16 flex flex-wrap justify-center gap-6 lg:max-w-4xl lg:mx-auto xl:max-w-none xl:mx-0">
            {/* Plan Freemium - toujours affiché en premier */}
            <div
              className={cn(
                'flex flex-col rounded-lg shadow-sm divide-y divide-border bg-card border',
                'flex-1 basis-1/3 max-w-xs'
              )}
            >
              <div className="p-6">
                <h2 className="text-2xl font-semibold leading-6 text-foreground">
                  {FREEMIUM_PLAN.name}
                </h2>
                <p className="mt-4 text-muted-foreground">{FREEMIUM_PLAN.description}</p>
                <p className="mt-8">
                  <span className="text-5xl font-extrabold text-foreground">
                    0€
                  </span>
                  <span className="text-base font-medium text-muted-foreground/70">
                    /{TRIAL_DAYS} jours
                  </span>
                </p>
                <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                  {FREEMIUM_PLAN.features.map((feature, idx) => (
                    <li key={idx} className="flex items-center gap-2">
                      <span className="text-primary">✓</span> {feature}
                    </li>
                  ))}
                </ul>
                <Button
                  variant="slim"
                  type="button"
                  onClick={() => router.push(user ? '/dashboard' : '/signin')}
                  className="block w-full py-2 mt-8 text-sm font-semibold text-center text-foreground rounded-md hover:bg-card"
                >
                  {user ? 'Accéder au Dashboard' : 'Commencer gratuitement'}
                </Button>
              </div>
            </div>

            {/* Plans payants depuis Stripe */}
            {products.map((product) => {
              const isCurrentPlan = subscription?.prices?.products?.name === product.name;
              const isEnterprise = product.name?.toLowerCase().includes('enterprise');

              let price = product?.prices?.find(
                (price) => price.interval === billingInterval
              );

              // Pour Enterprise, utiliser les prix v2/v3 (49€/mois, 490€/an)
              // Filtre par montant exact au lieu de lookup_key pour éviter une migration DB
              if (isEnterprise && price) {
                const targetAmount = billingInterval === 'month'
                  ? 4900  // 49€/mois (v2)
                  : 49000; // 490€/an (v3)

                const preferredPrice = product?.prices?.find(
                  (p) => p.unit_amount === targetAmount && p.interval === billingInterval
                );

                if (preferredPrice) {
                  price = preferredPrice;
                }
              }

              if (!price) return null;
              const priceString = new Intl.NumberFormat('fr-FR', {
                style: 'currency',
                currency: price.currency!,
                minimumFractionDigits: 0
              }).format((price?.unit_amount || 0) / 100);

              return (
                <div
                  key={product.id}
                  className={cn(
                    'flex flex-col rounded-lg shadow-sm divide-y divide-border bg-card border',
                    {
                      'border-2 border-primary shadow-md': isCurrentPlan,
                      'border-2 border-accent': isEnterprise && !isCurrentPlan
                    },
                    'flex-1 basis-1/3 max-w-xs'
                  )}
                >
                  <div className="p-6">
                    <div className="flex items-center justify-between">
                      <h2 className="text-2xl font-semibold leading-6 text-foreground">
                        {product.name}
                      </h2>
                      {isEnterprise && (
                        <span className="px-2 py-1 text-xs font-medium bg-accent text-accent-foreground rounded">
                          Populaire
                        </span>
                      )}
                    </div>
                    <p className="mt-4 text-muted-foreground">{product.description}</p>
                    <p className="mt-8">
                      <span className="text-5xl font-extrabold text-foreground">
                        {priceString}
                      </span>
                      <span className="text-base font-medium text-muted-foreground/70">
                        /{billingInterval === 'month' ? 'mois' : 'an'}
                      </span>
                    </p>
                    <Button
                      variant={isEnterprise ? 'default' : 'slim'}
                      type="button"
                      loading={priceIdLoading === price.id}
                      onClick={() => handleStripeCheckout(price)}
                      className={cn(
                        'block w-full py-2 mt-8 text-sm font-semibold text-center rounded-md',
                        isEnterprise ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'text-foreground hover:bg-card'
                      )}
                    >
                      {isCurrentPlan ? 'Gérer' : 'Souscrire'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <LogoCloud />
        </div>
      </section>
    );
  }
}
