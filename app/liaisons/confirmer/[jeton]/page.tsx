/** Le propriétaire confirme la première ouverture d'une paire d'apps : qui la demande, quel sens, ce que ça permet. */
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { lireDemande } from '@/lib/delegation/interrupteur';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

function Cadre({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-xl p-4 md:p-8">
      <Card>
        <CardHeader>
          <CardTitle>{titre}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </main>
  );
}

export default async function Confirmer({ params }: { params: Promise<{ jeton: string }> }) {
  const { jeton } = await params;
  if (jeton === 'fait') return <Cadre titre="Liaison allumée"><CardDescription>Vous pouvez la couper à tout moment, depuis Veridian ou depuis votre IA.</CardDescription></Cadre>;
  if (jeton === 'source') return <Cadre titre="L'app source n'a pas répondu"><CardDescription>La liaison est restée éteinte. Réessayez dans quelques minutes.</CardDescription></Cadre>;
  if (jeton === 'ancienne') return <Cadre titre="Reconnectez-vous"><CardDescription>Pour allumer une liaison, votre connexion doit dater de moins de 24 heures. Déconnectez-vous, reconnectez-vous, puis rouvrez le lien.</CardDescription></Cadre>;
  const user = await getCurrentUser();
  if (!user && jeton !== 'refus') redirect(`/login?callbackUrl=${encodeURIComponent(`/liaisons/confirmer/${jeton}`)}`);
  const d = user && jeton !== 'refus' ? await lireDemande(prisma, jeton, userUuid(user)) : null;
  if (!d) return <Cadre titre="Demande introuvable"><CardDescription>Elle a expiré, a déjà servi, ou seul le propriétaire de l&apos;espace peut la confirmer. Redemandez-la.</CardDescription></Cadre>;
  return (
    <Cadre titre="Allumer une liaison entre vos apps">
      <p>
        <strong>{d.client}</strong> demande, pour {d.demandePar}, à allumer dans l&apos;espace <strong>{d.espace}</strong> :
      </p>
      <p className="font-medium">{d.libelle}</p>
      <p className="text-sm text-muted-foreground">Ce que cela permet : {d.portees.join(', ')}. Rien n&apos;est jamais supprimé, aucun mail n&apos;est envoyé.</p>
      <form method="post" action="/api/integrations/confirmer">
        <input type="hidden" name="jeton" value={jeton} />
        <Button type="submit">Allumer</Button>
      </form>
      <p className="text-sm text-muted-foreground">Vous n&apos;avez rien demandé : fermez cette page, rien ne change.</p>
    </Cadre>
  );
}
