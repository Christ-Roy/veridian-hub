// Première entrée par le compte de son organisation : prouver l'adresse que l'organisation attend, une fois (VER-261).
import Link from 'next/link';
import { cookies } from 'next/headers';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { COOKIE_PREMIERE, ouvrirPremiere } from '@/lib/federation/premiere';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false } };

const AVIS: Record<string, string> = {
  adresse: 'Saisissez une adresse complète.',
  code_faux: 'Code incorrect ou expiré.',
  trop: 'Trop d\'essais. Réessayez dans dix minutes.',
};

export default async function PremiereEntree({ searchParams }: { searchParams: Promise<{ etape?: string; email?: string; avis?: string }> }) {
  const { etape, email, avis } = await searchParams;
  const valable = ouvrirPremiere((await cookies()).get(COOKIE_PREMIERE)?.value) !== null;
  const dit = AVIS[avis ?? ''];
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md space-y-4 p-8">
        <h1 className="text-xl font-semibold">Première entrée</h1>
        {!valable ? (
          <p role="status" className="text-sm text-muted-foreground">Cette demande a expiré. Repartez du lien de votre organisation.</p>
        ) : etape === 'code' && email ? (
          <form method="post" action="/api/auth/federation/premiere" className="space-y-4" autoComplete="off">
            <p className="text-sm text-muted-foreground">Si votre organisation vous attend sous cette adresse, un code vient d&apos;y être envoyé.</p>
            {dit ? <p role="status" className="text-sm">{dit}</p> : null}
            <input type="hidden" name="geste" value="confirmer" />
            <input type="hidden" name="email" value={email} />
            <div className="space-y-1">
              <Label htmlFor="code">Code reçu</Label>
              <Input id="code" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required autoFocus />
            </div>
            <Button type="submit" className="w-full">Entrer</Button>
            <Link href="/auth/premiere-entree" className="inline-flex min-h-11 items-center text-sm underline">Changer d&apos;adresse</Link>
          </form>
        ) : (
          <form method="post" action="/api/auth/federation/premiere" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Ce compte n&apos;est pas encore relié à votre accès Veridian. Donnez l&apos;adresse sous laquelle votre organisation vous a inscrit : un code y sera envoyé, une seule fois.
            </p>
            {dit ? <p role="status" className="text-sm">{dit}</p> : null}
            <input type="hidden" name="geste" value="demander" />
            <div className="space-y-1">
              <Label htmlFor="email">Adresse</Label>
              <Input id="email" name="email" type="email" required autoFocus />
            </div>
            <Button type="submit" className="w-full">Recevoir le code</Button>
          </form>
        )}
        <Link href="/login?normal=1" className="inline-flex min-h-11 items-center text-sm font-medium underline">Connexion habituelle</Link>
      </Card>
    </div>
  );
}
