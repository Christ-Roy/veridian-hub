'use client';

// Lien d'activation expiré : en redemander un, sans passer par nous (VER-104). Il part à l'adresse du compte, qu'on n'affiche pas ici.
import { useState } from 'react';

import { OnboardingScreen } from '@/components/onboarding/OnboardingScreen';
import type { OnboardingInvite } from '@/components/onboarding/types';

const SANS_ADRESSE: OnboardingInvite = { email: '', workspaceName: '', invitedBy: 'Veridian', apps: [], expiresAt: '' };
const REPONSES: Record<string, string> = {
  envoye: 'C’est parti : un nouveau lien vient d’être envoyé à l’adresse de votre compte.',
  encore_valable: 'Ce lien est de nouveau valable, rechargez la page.',
  actif: 'Votre compte est déjà actif, connectez-vous.',
  invalide: 'Un lien plus récent vous a été envoyé : ouvrez le dernier mail reçu.',
  rate_limited: 'Un lien vient déjà d’être demandé. Regardez votre boîte, puis réessayez dans une heure.',
};

export function LienExpire({ token }: { token: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [fait, setFait] = useState(false);

  async function renvoyer() {
    const r = await fetch(`/api/onboarding/${encodeURIComponent(token)}/renouveler`, { method: 'POST' }).catch(() => null);
    const code = (await r?.json().catch(() => null))?.code as string | undefined;
    setMessage(REPONSES[code ?? ''] ?? 'L’envoi a échoué, réessayez dans un instant.');
    setFait(Boolean(code && REPONSES[code]));
  }

  return (
    <OnboardingScreen state="token-expire" invite={SANS_ADRESSE} steps={[]} onRenvoyerLien={fait ? undefined : renvoyer} error={message} />
  );
}
