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

const PHASE_CONTENT: Record<TrialBannerPhase, BannerContent> = {
  // Phase 4 — trial révélé : ton sobre et positif, pas de deadline en gros.
  active: {
    message:
      'Tu es en essai gratuit Pro — accès complet à toutes les fonctionnalités.',
    ctaLabel: 'Voir les formules',
    ctaHref: '/pricing',
  },
  // Phase 5 — fin de trial proche : invitation positive, le cadeau 30j
  // inconditionnel est l'argument (cf doc pricing §"Flow trial complet").
  ending_soon: {
    message:
      'Ton essai gratuit touche à sa fin. Ajoute ta carte pour continuer — 30 jours offerts en plus.',
    ctaLabel: 'Ajouter ma carte',
    ctaHref: '/dashboard/billing',
  },
  // Expiration sans CB — paywall lecture seule, CTA "Réactiver".
  expired: {
    message: 'Ton essai gratuit est terminé.',
    ctaLabel: 'Réactiver',
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
