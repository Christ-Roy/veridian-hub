'use client';

import { Button } from '@/components/ui/button';
import { signOutWithHintClear } from '@/lib/auth/sign-out-with-hint-clear';

/** Se déconnecter du Hub pour revenir avec l'adresse qui a l'accès à l'app. */
export function ChangerDeCompte({ retour }: { retour: string }) {
  return (
    <Button variant="outline" onClick={() => void signOutWithHintClear({ callbackUrl: retour })}>
      Me connecter avec une autre adresse
    </Button>
  );
}
