import Link from "next/link"
import { ArrowRight, Check } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * CTA SECTION - Call-to-Action final de conversion
 *
 * Objectif: Dernière opportunité de convertir le visiteur avant le footer
 *
 * Blocs de code:
 * 1. Container avec gradient - Crée un bloc visuellement distinct
 * 2. Titre et description - Rappelle l'offre freemium
 * 3. Liste de bénéfices - Rassure l'utilisateur (no credit card, etc.)
 * 4. Bouton CTA - Appel à l'action final
 *
 * Design: Utilise un gradient border + glow effect pour attirer l'attention
 */
export function CTASection() {
  return (
    <section className="px-4 py-20 lg:px-6 lg:py-24">
      <div className="mx-auto max-w-5xl">
        {/* Bloc 1: Card avec style dashboard */}
        <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-b from-primary/5 to-card p-8 md:p-12 lg:p-16">
          <div className="relative">
            {/* Bloc 2: Contenu principal */}
            <div className="mb-8 text-center">
              <h2 className="mb-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl md:text-5xl">
                Prêt à développer votre business ?
              </h2>
              <p className="mx-auto max-w-2xl text-lg text-muted-foreground">
                Commencez gratuitement aujourd'hui. Accédez au CRM et Mail Automation en freemium,
                sans engagement.
              </p>
            </div>

            {/* Bloc 3: Liste des bénéfices - Rassure l'utilisateur */}
            <div className="mb-10 flex flex-wrap justify-center gap-6 text-sm md:gap-8">
              <div className="flex items-center gap-2">
                <div className="rounded-full bg-primary/10 p-1">
                  <Check className="size-4 text-primary" />
                </div>
                <span className="text-foreground">Aucune carte bancaire requise</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="rounded-full bg-primary/10 p-1">
                  <Check className="size-4 text-primary" />
                </div>
                <span className="text-foreground">Annulation à tout moment</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="rounded-full bg-primary/10 p-1">
                  <Check className="size-4 text-primary" />
                </div>
                <span className="text-foreground">Support 7j/7</span>
              </div>
            </div>

            {/* Bloc 4: Bouton CTA final */}
            <div className="flex justify-center">
              <Button asChild size="lg" className="gap-2 px-10 text-base">
                <Link href="/signup">
                  Créer mon compte gratuitement
                  <ArrowRight className="size-5" />
                </Link>
              </Button>
            </div>

            {/* Texte légal / reassurance */}
            <p className="mt-6 text-center text-xs text-muted-foreground">
              Rejoignez plus de 10 000 entrepreneurs qui font confiance à notre plateforme
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
