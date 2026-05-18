// Page tarifs Veridian.
//
// Architecture (refactor 2026-05-18) :
// - Source de vérité = lib/pricing/plans.ts (catalogue versionné).
// - Stripe ne sert qu'à PRENDRE le paiement (Price IDs référencés depuis le catalogue).
// - Aucune lecture Prisma products/prices ici — ces tables sont legacy (la sync
//   webhook a été dégagée).
// - JSON-LD SEO généré statiquement depuis le catalogue.

import { Metadata } from 'next';

import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { PricingGrid } from '@/components/pricing/PricingGrid';
import { getPublicPricingSections } from '@/lib/pricing/helpers';
import { PLANS, type Interval, type PlanKey } from '@/lib/pricing/plans';

export const metadata: Metadata = {
  title: 'Tarifs flexibles pour vos SaaS Veridian',
  description:
    'Plans Notifuse + Prospection à la carte ou en bundle dégressif. Essai gratuit 15 jours sans carte bancaire.',
  openGraph: {
    title: 'Tarifs Veridian | Plans flexibles pour vos SaaS',
    description:
      'Plans Notifuse + Prospection à la carte ou en bundle dégressif. Essai gratuit 15 jours sans carte bancaire.',
  },
};

function generateJsonLd() {
  const publicPlans = Object.values(PLANS).filter((p) => !p.hidden_from_public);

  const offers = publicPlans.map((plan) => ({
    '@type': 'Offer',
    name: plan.name,
    description: plan.tagline,
    price: String(plan.price_eur),
    priceCurrency: 'EUR',
  }));

  const prices = publicPlans
    .map((p) => p.price_eur)
    .filter((p) => p > 0);

  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Veridian',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description:
      'Plateforme SaaS tout-en-un : emails transactionnels (Notifuse) + qualification de leads .fr (Prospection).',
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'EUR',
      lowPrice: String(Math.min(...prices, 0)),
      highPrice: String(Math.max(...prices, 0)),
      offerCount: String(publicPlans.length),
      offers,
    },
  };
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; interval?: string; redirect?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();

  // Plan actuel du user (si loggé + subscription active)
  let currentPlanKey: PlanKey | null = null;
  if (user) {
    try {
      const sub = await prisma.subscription.findFirst({
        where: {
          userId: userUuid(user),
          status: { in: ['trialing', 'active'] },
        },
        select: { planName: true },
      });
      if (sub?.planName && sub.planName in PLANS) {
        currentPlanKey = sub.planName as PlanKey;
      }
    } catch (err) {
      console.warn('[Pricing] Subscription lookup failed:', err);
    }
  }

  const sections = getPublicPricingSections();
  const jsonLd = generateJsonLd();

  // Validation interval (default month)
  const interval: Interval =
    params.interval === 'year' || params.interval === 'month'
      ? params.interval
      : 'month';

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <PricingGrid
        bundles={sections.bundles}
        notifuse={sections.notifuse}
        prospection={sections.prospection}
        currentPlanKey={currentPlanKey}
        preselectedPlan={params.plan}
        preselectedInterval={interval}
        isAuthenticated={!!user}
        successRedirect={params.redirect}
      />
    </>
  );
}
