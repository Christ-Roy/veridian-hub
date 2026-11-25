// /dashboard/connexions : les services extérieurs que la personne relie à son compte (VER-244). Reliés, leurs outils arrivent à son IA avec ses apps.
import { redirect } from 'next/navigation';

import { PlugIcon } from 'lucide-react';

import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { connexionsDe } from '@/lib/connecteurs/coffre';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const AVIS: Record<string, string> = {
  branchee: 'Branché. Votre IA voit ses outils dès maintenant.',
  coupee: 'Coupé. Votre IA n\'y a plus accès.',
  absente: 'Ce service n\'était pas branché.',
  refusee: 'Vous avez refusé, rien n\'a été branché.',
  expiree: 'Cette demande a expiré, ou vient d\'un autre compte. Recommencez.',
  echec: 'Le service a répondu autre chose que ce qui était attendu. Rien n\'a été branché, réessayez.',
  injoignable: 'Ce service ne répond pas. Réessayez dans un instant.',
  trop: 'Trop de demandes. Réessayez dans une heure.',
  refus: 'Demande refusée.',
};

export default async function Connexions({ searchParams }: { searchParams: Promise<{ avis?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login?callbackUrl=/dashboard/connexions');
  const avis = AVIS[(await searchParams).avis ?? ''];
  const services = await connexionsDe(prisma, userUuid(user));
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <DashboardPageHeader title="Connexions" icon={PlugIcon} description="Reliez les outils que vous utilisez déjà. Votre IA les retrouve avec vos apps Veridian." />
      {avis ? <p role="status" className="text-sm">{avis}</p> : null}
      <Card className="p-6">
        <ul className="divide-y divide-border">
          {services.map((s) => (
            <li key={s.cle} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
              <div>
                <p className="font-medium">{s.nom}</p>
                <p className="text-sm text-muted-foreground">
                  {s.etat === 'a_rebrancher' ? 'À rebrancher : ce service ne vous reconnaît plus.' : s.texte}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {s.etat !== 'active' ? <Geste cle={s.cle} nom={s.nom} geste="brancher">{s.etat === 'a_rebrancher' ? 'Rebrancher' : 'Brancher'}</Geste> : null}
                {s.etat !== 'absente' ? <Geste cle={s.cle} nom={s.nom} geste="couper">Couper</Geste> : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <p className="text-sm text-muted-foreground">
        Vous vous connectez chez le service lui-même : Veridian ne voit jamais votre mot de passe. L&apos;accès est à vous seul, chiffré, et se coupe ici.
      </p>
    </div>
  );
}

function Geste({ cle, nom, geste, children }: { cle: string; nom: string; geste: string; children: React.ReactNode }) {
  return (
    <form method="post" action="/api/connecteurs">
      <input type="hidden" name="connecteur" value={cle} />
      <input type="hidden" name="geste" value={geste} />
      <Button type="submit" size="sm" variant={geste === 'couper' ? 'outline' : 'default'} aria-label={`${geste === 'couper' ? 'Couper' : 'Brancher'} ${nom}`}>{children}</Button>
    </form>
  );
}
