'use client';

import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { MESSAGE_RESEAU } from '@/lib/ui/messages';

/** Coupe toutes les sessions du compte, sur ce navigateur, les autres, et dans les outils. */
export function SignOutEverywhere() {
  const [enCours, setEnCours] = useState(false);
  const [ouvert, setOuvert] = useState(false);

  async function deconnecter() {
    setEnCours(true);
    const res = await fetch('/api/account/sessions/revoke-all', { method: 'POST' }).catch(() => null);
    if (!res?.ok) {
      toast.error('La déconnexion a échoué', {
        description: res ? 'Réessayez dans un instant.' : MESSAGE_RESEAU,
      });
      setEnCours(false);
      setOuvert(false);
      return;
    }
    // D9 : une app qui n'a pas confirmé la coupure garde sa session : on le dit, sans le cacher.
    const corps = (await res.json().catch(() => null)) as { apps_failed?: string[] } | null;
    const enEchec = corps?.apps_failed ?? [];
    if (enEchec.length > 0) {
      toast.warning("Déconnecté du Hub. Certains outils n'ont pas confirmé la coupure", {
        description: `À vérifier : ${enEchec.join(', ')}. La coupure y sera reprise sous peu.`,
        duration: 8000,
      });
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    await signOut({ callbackUrl: '/login' });
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        Cette action coupe votre accès sur tous vos appareils et dans tous vos outils Veridian.
      </p>
      <AlertDialog open={ouvert} onOpenChange={(o) => !enCours && setOuvert(o)}>
        <AlertDialogTrigger asChild>
          <Button variant="outline" className="w-full sm:w-auto" disabled={enCours}>
            {enCours ? 'Déconnexion...' : 'Se déconnecter partout'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Se déconnecter partout ?</AlertDialogTitle>
            <AlertDialogDescription>
              Vous serez déconnecté de cet appareil, de tous les autres et de tous les outils
              Veridian. Il faudra vous reconnecter partout.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={enCours}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              disabled={enCours}
              onClick={(e) => {
                e.preventDefault();
                void deconnecter();
              }}
            >
              {enCours ? 'Déconnexion...' : 'Me déconnecter partout'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
