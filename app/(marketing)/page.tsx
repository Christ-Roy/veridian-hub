import { Metadata } from 'next';
import { HeroSection } from "@/components/landing/hero-section"
import { FeaturesSection } from "@/components/landing/features-section"
import { CTASection } from "@/components/landing/cta-section"
import { GoogleOneTap } from "@/components/auth/GoogleOneTap"

export const metadata: Metadata = {
  title: 'Pilotez vos SaaS depuis une plateforme unique',
  description: 'Simplifiez votre business : centralisez Notifuse, Prospection et vos outils sur Veridian. Automatisez votre marketing et gérez vos clients sans friction.',
  openGraph: {
    title: 'Veridian | Pilotez vos SaaS depuis une plateforme unique',
    description: 'Simplifiez votre business : centralisez Notifuse, Prospection et vos outils sur Veridian. Automatisez votre marketing et gérez vos clients sans friction.'
  }
};

/**
 * LANDING PAGE - Page d'accueil principale (route /)
 *
 * Objectif business: Convertir les visiteurs en utilisateurs freemium
 *
 * Structure de la page:
 * 1. HeroSection - Accroche principale + CTA "Commencer gratuitement"
 * 2. FeaturesSection - Présentation détaillée CRM + Mail Automation
 * 3. CTASection - Rappel final pour conversion
 *
 * Layout parent: (marketing)/layout.tsx fournit Navbar + Footer
 *
 * IMPORTANT - Pas de logique technique pour l'instant:
 * - Les boutons CTA sont statiques (pas de lien vers /signup)
 * - Pas de queries Supabase
 * - On ajoutera l'auth et la redirection plus tard ensemble
 *
 * Ancienne version (Pricing):
 * - Remplacée par cette landing page moderne
 * - Le composant Pricing existe toujours dans /components/ui/Pricing
 * - On pourra créer une route /pricing dédiée si besoin plus tard
 */
export default function LandingPage() {
  return (
    <div className="flex flex-col">
      {/* Google One Tap : popup auto-login pour les visiteurs non-loggués.
          Ne rend aucun markup, se gate lui-même sur session + env + path. */}
      <GoogleOneTap callbackUrl="/dashboard" />

      {/* Bloc 1: Hero - Première impression et CTA principal */}
      <HeroSection />

      {/* Bloc 2: Features - Détail des services MVP */}
      <FeaturesSection />

      {/* Bloc 3: CTA Final - Dernière opportunité de conversion */}
      <CTASection />
    </div>
  )
}
