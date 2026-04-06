import { Metadata } from 'next';
import Pricing from '@/components/ui/Pricing/Pricing';
import { createClient } from '@/utils/supabase/server';
import {
  getProducts,
  getSubscription,
  getUser
} from '@/utils/supabase/queries';

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
 * Architecture:
 * - Server Component (récupère les données côté serveur)
 * - Utilise les queries Supabase existantes (🔒 logique préservée)
 * - Passe les données au composant Pricing.tsx client
 *
 * Données récupérées:
 * - user: Utilisateur connecté (ou null si non authentifié)
 * - products: Liste des produits Stripe actifs avec leurs prix
 * - subscription: Abonnement actif de l'utilisateur (si existe)
 *
 * Logique métier (dans Pricing.tsx):
 * - Si non connecté → Bouton "Subscribe" redirige vers /signin/signup
 * - Si connecté → Checkout Stripe avec redirection automatique
 * - Si déjà abonné → Bouton "Manage" (mise en évidence du plan actif)
 *
 * Layout parent: (marketing)/layout.tsx (Navbar + Footer dark)
 */

// Génère le JSON-LD dynamiquement à partir des produits Stripe
function generateJsonLd(products: any[]) {
  // Extraire les prix mensuels pour le schema
  const monthlyPrices = products
    .flatMap(p => p.prices?.filter((price: any) => price.interval === 'month') || [])
    .map((price: any) => (price.unit_amount || 0) / 100)
    .sort((a, b) => a - b);

  const offers = products.map(product => {
    const monthlyPrice = product.prices?.find((p: any) => p.interval === 'month');
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

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; interval?: string; redirect?: string }>;
}) {
  const supabase = createClient();
  const [user, products, subscription] = await Promise.all([
    getUser(supabase as any),
    getProducts(supabase as any),
    getSubscription(supabase as any)
  ]);

  const params = await searchParams;
  const jsonLd = generateJsonLd(products ?? []);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Pricing
        user={user}
        products={products ?? []}
        subscription={subscription}
        currentPath="/pricing"
        preselectedPlan={params.plan}
        preselectedInterval={params.interval as "month" | "year" | undefined}
        successRedirect={params.redirect}
      />
    </>
  );
}
