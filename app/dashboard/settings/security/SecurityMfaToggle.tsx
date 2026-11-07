// Client component pour le toggle 2FA email.
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { redirectIfReauthRequired } from '@/lib/auth/reauth-redirect';
import { MESSAGE_RESEAU } from '@/lib/ui/messages';

type Props = {
  initialEnabled: boolean;
  email: string;
  /** Le compte a un mot de passe : seul cas où le code email sait conclure une connexion. */
  hasPassword: boolean;
};

export const MESSAGE_MOT_DE_PASSE_REQUIS =
  'Définissez d’abord un mot de passe dans vos paramètres : la validation par email s’applique à la connexion par mot de passe.';

export function SecurityMfaToggle({ initialEnabled, email, hasPassword }: Props) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Activer sans mot de passe est refusé par le serveur : on ne propose pas le bouton.
  const peutActiver = hasPassword;

  async function onToggle() {
    setPending(true);
    setError(null);
    const next = !enabled;
    try {
      const res = await fetch('/api/auth/mfa/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (redirectIfReauthRequired(data)) return;
        setError(
          data?.error === 'password_required'
            ? MESSAGE_MOT_DE_PASSE_REQUIS
            : 'Impossible de mettre à jour le réglage. Réessayez.',
        );
        return;
      }
      setEnabled(next);
    } catch {
      setError(MESSAGE_RESEAU);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{enabled ? 'Activée' : 'Désactivée'}</p>
        <p className="text-muted-foreground">
          Les codes seront envoyés à <span className="break-all font-mono">{email}</span>.
        </p>
        {!enabled && !peutActiver && (
          <p className="mt-1 text-muted-foreground" data-testid="mfa-mot-de-passe-requis">
            {MESSAGE_MOT_DE_PASSE_REQUIS}
          </p>
        )}
        {error && (
          <p className="mt-1 text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      {(enabled || peutActiver) && (
        <Button
          type="button"
          onClick={onToggle}
          disabled={pending}
          variant={enabled ? 'outline' : 'default'}
          className="w-full sm:w-auto"
        >
          {pending ? '...' : enabled ? 'Désactiver' : 'Activer'}
        </Button>
      )}
    </div>
  );
}
