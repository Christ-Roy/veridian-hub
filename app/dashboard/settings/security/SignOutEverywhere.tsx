'use client';

import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

/** Coupe toutes les sessions du compte, sur ce navigateur, les autres, et dans les outils. */
export function SignOutEverywhere() {
  const [enCours, setEnCours] = useState(false);

  async function deconnecter() {
    setEnCours(true);
    const res = await fetch('/api/account/sessions/revoke-all', { method: 'POST' }).catch(() => null);
    if (!res?.ok) {
      toast.error('La déconnexion a échoué', { description: 'Réessayez dans un instant.' });
      setEnCours(false);
      return;
    }
    await signOut({ callbackUrl: '/login' });
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        Coupe votre accès sur tous vos appareils et dans tous vos outils Veridian.
      </p>
      <Button variant="outline" onClick={deconnecter} disabled={enCours}>
        Se déconnecter partout
      </Button>
    </div>
  );
}
