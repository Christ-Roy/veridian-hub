// Page d'arrivée du lien de preuve. Elle ne valide rien d'elle-même : le bouton
// poste le jeton, dans une session de ce compte (cf. lib/auth/email-proof.ts).

import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getCurrentUser } from '@/lib/auth/get-user';

export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  invalid: "Ce lien n'est plus valable. Demandez-en un nouveau depuis votre espace Veridian.",
  wrong_account:
    "Ce lien concerne un autre compte. Connectez-vous avec l'adresse qui a reçu ce mail, puis cliquez de nouveau sur le lien.",
};

export default async function EmailProofPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; result?: string }>;
}) {
  const { token, result } = await searchParams;
  const user = await getCurrentUser();

  if (!user && token) {
    const back = `/auth/email-proof?token=${encodeURIComponent(token)}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(back)}`);
  }

  const message = result ? MESSAGES[result] : undefined;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md p-8 space-y-4">
        <h1 className="text-xl font-semibold">Confirmer votre adresse</h1>
        {message || !token ? (
          <p className="text-sm text-muted-foreground">{message ?? MESSAGES.invalid}</p>
        ) : (
          <form method="post" action="/api/auth/email-proof/confirm" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Vous confirmez que {user?.email} est bien votre adresse.
            </p>
            <input type="hidden" name="token" value={token} />
            <Button type="submit" className="w-full">
              Confirmer mon adresse
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
