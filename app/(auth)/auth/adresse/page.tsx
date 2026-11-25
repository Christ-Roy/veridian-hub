// Arrivée du mail « votre adresse a changé » : rien ne se fait à l'ouverture (un antivirus ouvre les liens), seul le bouton annule.
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export const dynamic = 'force-dynamic';
export const metadata = { referrer: 'no-referrer' as const, robots: { index: false } };

const RESULTATS: Record<string, string> = {
  rendue: 'C\'est annulé. Cette adresse est de nouveau la vôtre et toutes les sessions sont coupées. Choisissez un nouveau mot de passe avec « mot de passe oublié ».',
  invalide: 'Ce lien n\'est plus valable : il a déjà servi, ou le délai est passé.',
  prise: 'Cette adresse appartient désormais à un autre compte. Écrivez-nous : contact@veridian.site.',
};

export default async function AdressePage({ searchParams }: { searchParams: Promise<{ token?: string; result?: string }> }) {
  const { token, result } = await searchParams;
  const dit = RESULTATS[result ?? ''] ?? (token ? null : RESULTATS.invalide);
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md space-y-4 p-8">
        <h1 className="text-xl font-semibold">Votre adresse Veridian a changé</h1>
        {dit ? (
          <>
            <p role="status" className="text-sm text-muted-foreground">{dit}</p>
            <Link href="/login" className="inline-flex min-h-11 items-center text-sm font-medium underline">Aller à la connexion</Link>
          </>
        ) : (
          <form method="post" action="/api/account/adresses/annuler" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Si ce n&apos;est pas vous : cette adresse redevient la vôtre, toutes les sessions sont coupées, le mot de passe et les comptes reliés (Google, votre organisation) sont retirés.
            </p>
            <input type="hidden" name="token" value={token} />
            <Button type="submit" className="w-full">Ce n&apos;est pas moi, annuler</Button>
          </form>
        )}
      </Card>
    </div>
  );
}
