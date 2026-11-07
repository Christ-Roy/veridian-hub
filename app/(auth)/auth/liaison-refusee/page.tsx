// Page d'arrivée quand la connexion OAuth est refusée (D1) : l'adresse du compte n'est pas
// certifiée par le fournisseur. Elle ne rattache rien : on explique et on renvoie au mot de passe.

import Link from 'next/link';

import { Card } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default function LiaisonRefuseePage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md p-8 space-y-4">
        <h1 className="text-xl font-semibold">Connexion impossible avec ce compte</h1>
        <p className="text-sm text-muted-foreground">
          Une adresse existe déjà chez Veridian, mais le compte Google ou Microsoft utilisé
          ne certifie pas qu&apos;il vous appartient. Pour votre sécurité, il n&apos;est pas rattaché
          automatiquement.
        </p>
        <p className="text-sm text-muted-foreground">
          Connectez-vous avec votre adresse et votre mot de passe. Si vous n&apos;en avez pas,
          utilisez « Mot de passe oublié » : le lien arrive dans votre boîte, et vous pourrez
          ensuite utiliser ce bouton.
        </p>
        <Link href="/login" className="inline-block text-sm font-medium underline">
          Retour à la connexion
        </Link>
      </Card>
    </div>
  );
}
