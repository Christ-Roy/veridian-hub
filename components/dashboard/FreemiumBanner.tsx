'use client';

import { useState } from 'react';
import { XIcon } from 'lucide-react';
import Link from 'next/link';
import type { TrialBannerPhase } from '@/lib/trial/banner-state';

/**
 * Bandeau trial du dashboard.
 *
 * ⚠️ Conforme `docs/PRICING-VERIDIAN.md` §"Interdits côté code" :
 *   - ❌ PAS de compteur visible ni de barre de progression anxiogène.
 *   - ❌ PAS d'affichage de timer trial avant la phase de révélation (J+2).
 *   - ✅ Bandeau visible UNIQUEMENT à partir de la phase 4 (trial révélé).
 *
 * Ce composant ne calcule plus aucune date côté client : il ne fait
 * qu'afficher la `phase` que la state machine a déjà résolue côté serveur
 * (`lib/trial/banner-state.ts`, query dans `app/dashboard/layout.tsx`).
 * Si aucune phase n'est passée le layout ne monte tout simplement pas ce
 * composant — on garde malgré tout un garde-fou défensif ici.
 */
interface FreemiumBannerProps {
  /**
   * Phase trial résolue côté serveur. `undefined`/`null` → rien à afficher
   * (le layout gate déjà en amont, ceci n'est qu'un garde-fou).
   */
  phase?: TrialBannerPhase | null;
}

interface BannerContent {
  /** Message principal, ton conforme au flow trial du doc pricing. */
  message: string;
  /** Libellé du CTA. */
  ctaLabel: string;
  /** Destination du CTA. */
  ctaHref: string;
}

export const PHASE_CONTENT: Record<TrialBannerPhase, BannerContent> = {
  // Textes réécrits le 08/11 : vouvoiement, aucune promesse non codée (ni lecture seule, ni bonus de
  // 30 jours). À la fin, l'espace revient au plan gratuit, rien n'est bloqué, rien n'est débité.
  // Phase 4, essai révélé : ton sobre, pas de date en gros.
  active: {
    message: 'Vous êtes en essai gratuit du plan Pro.',
    ctaLabel: 'Voir les formules',
    ctaHref: '/pricing',
  },
  // Phase 5, fin d'essai proche.
  ending_soon: {
    message:
      'Votre essai Pro se termine bientôt. Votre espace reviendra ensuite au plan gratuit, sans rien bloquer.',
    ctaLabel: 'Garder le plan Pro',
    ctaHref: '/dashboard/billing',
  },
  // Essai terminé sans carte : retour au plan gratuit, rien de bloqué.
  expired: {
    message: 'Votre essai Pro est terminé : votre espace est revenu au plan gratuit.',
    ctaLabel: 'Voir les formules',
    ctaHref: '/pricing',
  },
};

export function FreemiumBanner({ phase }: FreemiumBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);

  // Garde-fou : pas de phase => rien (le layout gate déjà en amont).
  if (!phase || isDismissed) {
    return null;
  }

  const content = PHASE_CONTENT[phase];

  return (
    <div className="freemium-banner text-foreground" role="status">
      <div className="flex items-center justify-between gap-3 px-4 py-3 max-w-7xl mx-auto">
        <p className="text-sm flex-1 min-w-0">{content.message}</p>

        <div className="flex items-center gap-3 shrink-0">
          <Link
            href={content.ctaHref}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-md font-medium text-sm hover:bg-primary/90 transition-colors"
          >
            {content.ctaLabel}
          </Link>

          <button
            type="button"
            onClick={() => setIsDismissed(true)}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
            aria-label="Fermer le bandeau"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
