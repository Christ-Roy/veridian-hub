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

  // ── Handlers réels, un par action du client ───────────────────────────
  //
  // 🔴 Ils ont remplacé un unique `onAdvance(next: OnboardingStateId)`, qui
  // rendait ce composant INBRANCHABLE : le mot de passe saisi était jeté
  // (`onSubmit={() => onAdvance('en-cours')}` ignorait son argument), et
  // `submitting` / `error` de `PasswordScreen` n'avaient aucune prop pour
  // être alimentés — donc ni état d'envoi, ni affichage d'une erreur serveur
  // (« ce lien n'est plus valide »). Brancher `/onboard/[token]` imposait
  // alors soit d'ajouter ces props, soit de contourner le composant et de
  // recomposer les six écrans à la main.

  /** L'écran d'activation : « Activer mon compte ». */
  onActiver?: () => void;
  /** Le mot de passe choisi par le client — la donnée qui était perdue. */
  onDefinirMotDePasse?: (password: string) => void;
  /** Lien expiré : renvoyer une invitation. */
  onRenvoyerLien?: () => void;
  /** Erreur technique : relancer. */
  onReessayer?: () => void;
  /**
   * Entrer dans l'espace depuis l'écran final.
   *
   * ⚠️ Optionnel, et surtout NON fourni par défaut : `DoneScreen` choisit
   * entre un `<Button onClick>` et un `<a href={dashboardHref}>` selon la
   * présence de cette prop. L'ancien `onEnter={() => undefined}` était
   * truthy, donc la branche bouton était rendue… et le clic ne faisait rien :
   * le client arrivait au bout de l'onboarding sans aucun moyen d'entrer dans
   * son espace. Sans handler, on laisse le lien faire son travail.
   */
  onEntrer?: () => void;

  /** Envoi du mot de passe en cours (désactive le formulaire). */
  submitting?: boolean;
  /** Erreur serveur à afficher sur l'écran de mot de passe. */
  error?: string | null;
}

/**
 * Point d'entrée unique du flow : un état → un écran, dans l'habillage
 * commun. La future page réelle `/onboard/[token]` n'a qu'à calculer `state`
 * côté serveur et brancher les handlers ci-dessus ; toute l'UI est ici, déjà
 * revue dans l'atelier `/dev/onboarding`.
 */
export function OnboardingScreen({
  state,
  invite,
  steps,
  onActiver,
  onDefinirMotDePasse,
  onRenvoyerLien,
  onReessayer,
  onEntrer,
  submitting,
  error,
}: OnboardingScreenProps) {
  return (
    <OnboardingShell brandBaseline={BASELINES[state]}>
      {state === 'activation' && (
        <ActivationScreen invite={invite} onContinue={() => onActiver?.()} />
      )}

      {state === 'mot-de-passe' && (
        <PasswordScreen
          invite={invite}
          onSubmit={(password) => onDefinirMotDePasse?.(password)}
          submitting={submitting}
          error={error}
        />
      )}

      {state === 'en-cours' && (
        <ProgressScreen workspaceName={invite.workspaceName} steps={steps} />
      )}

      {state === 'termine' && <DoneScreen invite={invite} onEnter={onEntrer} />}

      {state === 'erreur' && (
        <ErrorScreen variant="technique" onRetry={() => onReessayer?.()} />
      )}

      {state === 'token-expire' && (
        <ErrorScreen
          variant="expire"
          email={invite.email}
          onRetry={() => onRenvoyerLien?.()}
        />
      )}
    </OnboardingShell>
  );
}
