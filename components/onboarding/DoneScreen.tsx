'use client';

import { useEffect } from 'react';
import { ArrowRight, PartyPopper } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { VeridianWordmark } from '@/components/icons/VeridianHubLogo';
import { celebrate } from '@/lib/confetti';

import type { OnboardingInvite } from './types';

/**
 * Écran 4 — onboarding terminé. Le compte est actif, les apps sont liées :
 * on célèbre et on envoie le client dans son espace d'un seul clic.
 *
 * Les confettis sont déclenchés une fois au montage (no-op si
 * `prefers-reduced-motion`, cf. `lib/confetti`).
 */
export function DoneScreen({
  invite,
  dashboardHref = '/dashboard',
  onEnter,
}: {
  invite: OnboardingInvite;
  dashboardHref?: string;
  onEnter?: () => void;
}) {
  useEffect(() => {
    celebrate();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15">
          <PartyPopper className="h-6 w-6 text-success" aria-hidden />
        </span>
        <h1 className="text-2xl font-bold">Votre compte est prêt</h1>
        <p className="text-balance text-sm text-muted-foreground">
          {invite.workspaceName} est actif. Vous pouvez vous connecter dès
          maintenant avec {invite.email}.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-4">
        <div className="text-sm font-medium">Vos outils disponibles</div>
        {invite.apps.map((app) => (
          <div key={app.id} className="flex items-center gap-3">
            <VeridianWordmark size="xs" suffix={app.suffix} className="shrink-0" />
            <span className="text-xs text-muted-foreground">{app.tagline}</span>
          </div>
        ))}
      </div>

      {onEnter ? (
        <Button type="button" className="w-full" onClick={onEnter}>
          Entrer dans mon espace
          <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
        </Button>
      ) : (
        <Button asChild className="w-full">
          <a href={dashboardHref}>
            Entrer dans mon espace
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
          </a>
        </Button>
      )}
    </div>
  );
}
