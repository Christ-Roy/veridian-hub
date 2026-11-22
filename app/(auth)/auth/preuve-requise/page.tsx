// Page d'arrivée quand un compte NEUF serait créé par un fournisseur qui ne certifie pas l'adresse (M2,
// pré-prise de compte). Rien n'est créé : on explique et on mène à l'inscription par adresse, dont le lien de
// preuve part dans la boîte.

import Link from 'next/link';

import { Card } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default function PreuveRequisePage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md p-8 space-y-4" data-refus="preuve_requise">
        <h1 className="text-xl font-semibold">Confirmez d&apos;abord votre adresse</h1>
        <p className="text-sm text-muted-foreground">
          Le compte Google ou Microsoft utilisé ne certifie pas que l&apos;adresse vous appartient. Pour votre
          sécurité, aucun compte Veridian n&apos;est créé avec lui.
        </p>
        <p className="text-sm text-muted-foreground">
          Créez votre compte avec votre adresse : un lien de confirmation arrive dans votre boîte. Une fois
          l&apos;adresse confirmée, vous pourrez vous connecter avec un compte Google ou Microsoft qui la certifie.
        </p>
        <Link href="/signup" className="inline-flex min-h-11 items-center text-sm font-medium underline">
          Créer mon compte avec mon adresse
        </Link>
        <Link href="/login" className="block text-sm text-muted-foreground underline">
          Retour à la connexion
        </Link>
      </Card>
    </div>
  );
}
