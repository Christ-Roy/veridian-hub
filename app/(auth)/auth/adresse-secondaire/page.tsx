// Quelqu'un se connecte avec une adresse qui est la SECONDAIRE d'un compte (S1b) : il passe par sa principale.
import Link from 'next/link';

import { Card } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default function AdresseSecondairePage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md p-8 space-y-4">
        <h1 className="text-xl font-semibold">Cette adresse est rattachée à un compte</h1>
        <p className="text-sm text-muted-foreground">
          Elle a été ajoutée à un compte Veridian comme adresse secondaire. Connectez-vous avec l&apos;adresse principale de ce compte.
        </p>
        <Link href="/login" className="inline-flex min-h-11 items-center text-sm font-medium underline">
          Retour à la connexion
        </Link>
      </Card>
    </div>
  );
}
