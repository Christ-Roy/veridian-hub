import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { resolvePlateformeUrl } from '@/lib/marketing-url';

/**
 * État vide de la page billing : l'utilisateur n'a aucune subscription.
 *
 * Remplace l'ancien lien texte nu "View pricing plans" par un bloc cadré et
 * actionnable — phrase d'accroche + bouton vers la grille tarifaire. Ton
 * positif, cohérent avec la philosophie pricing (générosité, pas de mur).
 */
export function EmptyBillingState() {
  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <Sparkles className="h-6 w-6 text-primary" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">Aucun abonnement actif</p>
        <p className="text-sm text-muted-foreground max-w-md">
          Choisissez une formule pour profiter de toutes les fonctionnalités
          Veridian. Toutes les formules sont sans engagement.
        </p>
      </div>
      <Button asChild className="w-fit">
        <a href={resolvePlateformeUrl()} target="_blank" rel="noopener noreferrer">
          Découvrir les formules
        </a>
      </Button>
    </div>
  );
}
