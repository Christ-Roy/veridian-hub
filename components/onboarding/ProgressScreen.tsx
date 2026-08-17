import { AlertCircle, Check, Circle, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { OnboardingStep, OnboardingStepStatus } from './types';

const ICONS: Record<
  OnboardingStepStatus,
  { Icon: typeof Check; className: string; spin?: boolean }
> = {
  termine: { Icon: Check, className: 'text-success' },
  'en-cours': { Icon: Loader2, className: 'text-foreground', spin: true },
  'a-venir': { Icon: Circle, className: 'text-muted-foreground' },
  echec: { Icon: AlertCircle, className: 'text-destructive' },
};

const LIBELLES: Record<OnboardingStepStatus, string> = {
  termine: 'Terminé',
  'en-cours': 'En cours',
  'a-venir': 'En attente',
  echec: 'Échec',
};

/**
 * Écran 3 — activation en cours. Le provisioning des apps prend quelques
 * secondes : on montre ce qui se passe plutôt qu'un spinner muet, pour que
 * le client ne referme pas l'onglet.
 */
export function ProgressScreen({
  workspaceName,
  steps,
}: {
  workspaceName: string;
  steps: OnboardingStep[];
}) {
  const done = steps.filter((s) => s.status === 'termine').length;
  // Garde sur la liste vide : `0 / 0` donne NaN, qui partait tel quel dans
  // `aria-valuenow` ET dans `style={{ width: 'NaN%' }}` — déclaration CSS
  // invalide, donc barre de largeur indéfinie. Le test qui « couvrait » ce
  // cas acceptait `'0' || 'NaN'`, donc il passait aussi bien sur le
  // composant correct que sur le composant cassé.
  const pourcentage = steps.length === 0 ? 0 : Math.round((done / steps.length) * 100);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-2xl font-bold">On prépare votre espace</h1>
        <p className="text-balance text-sm text-muted-foreground">
          {workspaceName} sera prêt dans quelques instants.
        </p>
      </div>

      <div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pourcentage}
          aria-label="Progression de l’activation"
        >
          <div
            className="h-full rounded-full bg-foreground transition-all duration-500"
            style={{ width: `${pourcentage}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {done} étape{done > 1 ? 's' : ''} sur {steps.length}
        </p>
      </div>

      <ul className="flex flex-col gap-4" aria-live="polite">
        {steps.map((step) => {
          const { Icon, className, spin } = ICONS[step.status];
          return (
            <li key={step.id} className="flex items-start gap-3">
              <Icon
                aria-hidden
                className={cn('mt-0.5 h-5 w-5 shrink-0', className, spin && 'animate-spin')}
              />
              <div className="min-w-0">
                <div
                  className={cn(
                    'text-sm font-medium',
                    step.status === 'a-venir' && 'text-muted-foreground',
                  )}
                >
                  {step.label}
                  <span className="sr-only"> — {LIBELLES[step.status]}</span>
                </div>
                {step.detail && (
                  <div className="text-xs text-muted-foreground">{step.detail}</div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
