'use client';

import { ActivationScreen } from './ActivationScreen';
import { DoneScreen } from './DoneScreen';
import { ErrorScreen } from './ErrorScreen';
import { OnboardingShell } from './OnboardingShell';
import { PasswordScreen } from './PasswordScreen';
import { ProgressScreen } from './ProgressScreen';
import type { OnboardingInvite, OnboardingStateId, OnboardingStep } from './types';

/** Baseline du panneau de marque, adaptée à l'état affiché. */
const BASELINES: Record<OnboardingStateId, string> = {
  activation: 'Votre espace Veridian est prêt. Il ne manque plus que vous.',
  'mot-de-passe': 'Un seul mot de passe pour tous vos outils Veridian.',
  'en-cours': 'Vos outils s’installent. Ça ne prend qu’un instant.',
  termine: 'Bienvenue chez Veridian. Vos outils vous attendent.',
  erreur: 'Un imprévu, rien de perdu. On règle ça ensemble.',
  'token-expire': 'Les liens d’activation expirent. Votre compte, lui, reste là.',
};

export interface OnboardingScreenProps {
  state: OnboardingStateId;
  invite: OnboardingInvite;
  steps: OnboardingStep[];
  /** Passe à l'étape suivante (l'atelier s'en sert pour naviguer). */
  onAdvance?: (next: OnboardingStateId) => void;
}

/**
 * Point d'entrée unique du flow : un état → un écran, dans l'habillage
 * commun. La future page réelle `/onboard/[token]` n'aura qu'à calculer
 * `state` côté serveur et brancher les vrais handlers ; toute l'UI est ici,
 * déjà revue dans l'atelier `/dev/onboarding`.
 */
export function OnboardingScreen({
  state,
  invite,
  steps,
  onAdvance,
}: OnboardingScreenProps) {
  return (
    <OnboardingShell brandBaseline={BASELINES[state]}>
      {state === 'activation' && (
        <ActivationScreen
          invite={invite}
          onContinue={() => onAdvance?.('mot-de-passe')}
        />
      )}

      {state === 'mot-de-passe' && (
        <PasswordScreen invite={invite} onSubmit={() => onAdvance?.('en-cours')} />
      )}

      {state === 'en-cours' && (
        <ProgressScreen workspaceName={invite.workspaceName} steps={steps} />
      )}

      {state === 'termine' && <DoneScreen invite={invite} onEnter={() => undefined} />}

      {state === 'erreur' && (
        <ErrorScreen variant="technique" onRetry={() => onAdvance?.('en-cours')} />
      )}

      {state === 'token-expire' && (
        <ErrorScreen
          variant="expire"
          email={invite.email}
          onRetry={() => onAdvance?.('activation')}
        />
      )}
    </OnboardingShell>
  );
}
