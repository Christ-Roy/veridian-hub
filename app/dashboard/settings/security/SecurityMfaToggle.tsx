// Client component pour le toggle 2FA email.
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

type Props = {
  initialEnabled: boolean;
  email: string;
};

export function SecurityMfaToggle({ initialEnabled, email }: Props) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        throw new Error('toggle_failed');
      }
      setEnabled(next);
    } catch (e) {
      setError('Impossible de mettre à jour le réglage. Réessaye.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 text-sm">
        <p className="font-medium">
          {enabled ? 'Activée' : 'Désactivée'}
        </p>
        <p className="text-muted-foreground">
          Les codes seront envoyés à <span className="font-mono">{email}</span>.
        </p>
        {error && <p className="text-destructive mt-1">{error}</p>}
      </div>
      <Button
        type="button"
        onClick={onToggle}
        disabled={pending}
        variant={enabled ? 'outline' : 'default'}
      >
        {pending ? '...' : enabled ? 'Désactiver' : 'Activer'}
      </Button>
    </div>
  );
}
