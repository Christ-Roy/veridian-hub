'use client';

import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useEffect, useRef, useState } from 'react';

import { OnboardingScreen } from '@/components/onboarding/OnboardingScreen';
import type {
  OnboardingInvite,
  OnboardingStateId,
  OnboardingStep
} from '@/components/onboarding/types';
import {
  QualificationFlow,
  type EtatEnregistrement
} from '@/components/onboarding/qualification/QualificationFlow';
import type {
  OnboardingUser,
  UserOnboardingRecord
} from '@/components/onboarding/qualification/types';

type Phase = 'activation' | 'qualification';

const INITIAL_STEPS: OnboardingStep[] = [
  {
    id: 'password',
    label: 'Sécurisation du compte',
    status: 'termine',
    detail: 'Mot de passe enregistré côté Hub.'
  },
  {
    id: 'session',
    label: 'Connexion à votre espace',
    status: 'en-cours',
    detail: 'Création de la session client.'
  },
  {
    id: 'apps',
    label: 'Vérification des outils',
    status: 'a-venir',
    detail: 'Les accès Veridian sont synchronisés.'
  }
];

export function OnboardClient({
  token,
  invite
}: {
  token: string;
  invite: OnboardingInvite;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('activation');
  const [state, setState] = useState<OnboardingStateId>('activation');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<OnboardingStep[]>(INITIAL_STEPS);
  const [onboardingRecord, setOnboardingRecord] =
    useState<UserOnboardingRecord | null>(null);
  const [enregistrement, setEnregistrement] =
    useState<EtatEnregistrement>('idle');
  const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));

  const prenomBrut = invite.email.split('@')[0]?.split(/[._-]/)[0] || 'vous';
  const onboardingUser: OnboardingUser = {
    prenom:
      prenomBrut === 'vous'
        ? prenomBrut
        : prenomBrut.charAt(0).toLocaleUpperCase('fr-FR') + prenomBrut.slice(1),
    email: invite.email,
    workspaceName: invite.workspaceName
  };

  useEffect(() => {
    if (phase !== 'qualification') return;
    let cancelled = false;
    fetch('/api/onboarding/qualification', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.onboarding) {
          setOnboardingRecord(data.onboarding as UserOnboardingRecord);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [phase]);

  async function persistOnboardingRecord(
    record: UserOnboardingRecord,
    completed: boolean
  ): Promise<boolean> {
    const save = saveQueueRef.current.then(async () => {
      setEnregistrement('en-cours');
      const qualification = record.metadata?.qualification ?? {};
      const etapeCourante = record.metadata?.etapeCourante;
      try {
        const res = await fetch('/api/onboarding/qualification', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            qualification,
            etapeCourante,
            completed
          })
        });
        if (!res.ok) {
          setEnregistrement('erreur');
          return false;
        }
        const data = await res.json().catch(() => null);
        if (data?.onboarding) {
          setOnboardingRecord(data.onboarding as UserOnboardingRecord);
        } else {
          setOnboardingRecord(record);
        }
        setEnregistrement('idle');
        return true;
      } catch {
        setEnregistrement('erreur');
        return false;
      }
    });

    saveQueueRef.current = save.catch(() => false);
    return save;
  }

  async function activate(password: string) {
    setSubmitting(true);
    setError(null);
    setState('en-cours');
    setSteps(INITIAL_STEPS);

    try {
      const res = await fetch(
        `/api/onboarding/${encodeURIComponent(token)}/activate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        }
      );
      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.ok) {
        const code = data?.code ?? data?.error;
        // Deux onglets peuvent soumettre le même lien presque simultanément.
        // Le second perd proprement la course atomique côté serveur : son
        // compte est déjà actif, donc le renvoyer vers le formulaire de mot
        // de passe créerait une boucle de soumission impossible à résoudre.
        if (code === 'activated') {
          router.replace('/login');
          router.refresh();
          setSubmitting(false);
          return;
        }
        if (code === 'expired') setState('token-expire');
        else setState('mot-de-passe');
        setError(
          'Impossible d’activer ce lien. Réessayez ou demandez un nouveau lien.'
        );
        setSubmitting(false);
        return;
      }

      setSteps((current) =>
        current.map((step) =>
          step.id === 'session'
            ? {
                ...step,
                status: 'en-cours',
                detail: 'Connexion automatique en cours.'
              }
            : step.id === 'apps'
              ? {
                  ...step,
                  status: 'en-cours',
                  detail: 'Dernière synchronisation.'
                }
              : step
        )
      );

      const signInResult = await signIn('credentials', {
        email: invite.email,
        password,
        redirect: false
      });

      if (signInResult?.error) {
        setState('mot-de-passe');
        setError(
          'Votre mot de passe est enregistré, mais la connexion automatique a échoué. Connectez-vous depuis la page de login.'
        );
        setSubmitting(false);
        return;
      }

      setSteps((current) =>
        current.map((step) => ({ ...step, status: 'termine' }))
      );
      setOnboardingRecord(makeInitialOnboardingRecord(data.user_id));
      setPhase('qualification');
      setSubmitting(false);
      router.refresh();
    } catch {
      setState('mot-de-passe');
      setError('Erreur réseau. Réessayez dans quelques secondes.');
      setSubmitting(false);
    }
  }

  if (phase === 'qualification') {
    const record = onboardingRecord ?? makeInitialOnboardingRecord('pending');
    return (
      <QualificationFlow
        user={onboardingUser}
        etat={record}
        enregistrement={enregistrement}
        onRepondre={(next) => {
          setOnboardingRecord(next);
          void persistOnboardingRecord(next, false);
        }}
        onTerminer={(next) => {
          setOnboardingRecord(next);
          void persistOnboardingRecord(next, true);
        }}
        onQuitter={() => router.push('/dashboard')}
      />
    );
  }

  return (
    <OnboardingScreen
      state={state}
      invite={invite}
      steps={steps}
      onActiver={() => setState('mot-de-passe')}
      onDefinirMotDePasse={activate}
      onEntrer={() => router.push('/dashboard')}
      onReessayer={() => setState('mot-de-passe')}
      submitting={submitting}
      error={error}
    />
  );
}

function makeInitialOnboardingRecord(userId: string): UserOnboardingRecord {
  return {
    userId,
    invitedAt: null,
    activatedAt: new Date().toISOString(),
    firstAppStartedAt: null,
    memberInvitedAt: null,
    workspaceRenamedAt: null,
    completedAt: null,
    metadata: { qualification: {}, etapeCourante: 'accueil' }
  };
}
