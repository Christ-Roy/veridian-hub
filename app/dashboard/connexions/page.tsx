// /dashboard/connexions : les services extérieurs que la personne relie à son compte (VER-244). Reliés, leurs outils relus arrivent à son IA avec ses apps.
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PlugIcon } from 'lucide-react';

import { auth } from '@/auth';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { connexionsDe, type EtatConnexion } from '@/lib/connecteurs/coffre';
import { connecteur, connecteursOuverts } from '@/lib/connecteurs/registre';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** Chez nous seulement : le service n'a pas confirmé. On ne dit jamais « coupé » d'un accès qui vit peut-être encore chez lui. */
const chezEux = (nom: string) => `${nom} n'a pas confirmé la coupure de son côté : retirez aussi « Veridian » dans les réglages de ${nom}, l'accès peut encore y vivre.`;
const AVIS: Record<string, (nom: string) => string> = {
  branchee: () => 'Branché, en lecture seule. Une IA que vous autorisez à partir de maintenant pourra y lire.',
  a_confirmer: (n) => `${n} est déjà relié : choisissez ci-dessous le compte à garder. Rien n'a été remplacé.`,
  coupee: (n) => `Coupé. Votre IA n'y a plus accès, et ${n} l'a confirmé de son côté.`,
  coupee_ici: (n) => `Coupé ici : votre IA n'y a plus accès par Veridian. ${chezEux(n)}`,
  absente: () => 'Ce service n\'était pas branché.',
  ecriture: () => 'Écriture allumée pour ce service. Vous l\'éteignez ici quand vous voulez.',
  lecture: () => 'Écriture éteinte : ce service est en lecture seule.',
  remplace: () => 'Remplacé, en lecture seule. L\'accès à l\'ancien compte est coupé.',
  remplace_ici: (n) => `Remplacé, en lecture seule. Pour l'ancien compte : ${chezEux(n)}`,
  garde: () => 'Compte gardé. Le nouvel accès a été coupé.',
  garde_ici: (n) => `Compte gardé. Pour le nouveau : ${chezEux(n)}`,
  tranche: () => 'Ce choix était déjà fait, ou n\'est plus possible.',
  refusee: () => 'Vous avez refusé, rien n\'a été branché.',
  expiree: () => 'Cette demande a expiré, ou vient d\'un autre compte. Recommencez.',
  echec: () => 'Le service a répondu autre chose que ce qui était attendu. Rien n\'a été branché, réessayez.',
  injoignable: () => 'Ce service ne répond pas comme attendu. Réessayez dans un instant.',
  trop: () => 'Trop de demandes. Réessayez dans une heure.',
  refus: () => 'Demande refusée.',
  ferme: () => 'Cette fonction n\'est pas encore ouverte.',
};

export default async function Connexions({ searchParams }: { searchParams: Promise<{ avis?: string; service?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login?callbackUrl=/dashboard/connexions');
  const session = await auth();
  // Ces connexions sont à la personne : ni son organisation ni un opérateur ne les voient par leur session.
  const sienne = Boolean(session?.user) && !isImpersonatedSession(session) && session?.user?.federe !== true;
  const p = await searchParams;
  const avis = Object.hasOwn(AVIS, p.avis ?? '') ? AVIS[p.avis!](connecteur(p.service)?.nom ?? 'Le service') : undefined;
  const ouvert = connecteursOuverts(userUuid(user));
  // Fermé : seul ce qui est branché se montre, pour pouvoir le couper.
  const services = sienne ? (await connexionsDe(prisma, userUuid(user))).filter((s) => ouvert || s.etat !== 'absente') : [];
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <DashboardPageHeader title="Connexions" icon={PlugIcon} description="Reliez les outils que vous utilisez déjà. Votre IA les retrouve avec vos apps Veridian." />
      {avis ? <p role="status" className="text-sm">{avis}</p> : null}
      {!sienne ? <p className="text-sm text-muted-foreground">Vos connexions personnelles se règlent avec votre propre connexion (mot de passe, lien ou Google).</p> : services.length > 0 ? <Card className="p-6">
        <ul className="divide-y divide-border">
          {services.map((s) => <Service key={s.cle} s={s} ouvert={ouvert} />)}
        </ul>
      </Card> : <p className="text-sm text-muted-foreground">Aucun service extérieur n&apos;est branché. Cette fonction n&apos;est pas encore ouverte.</p>}
      <Card className="flex items-center justify-between gap-4 p-6">
        <div>
          <p className="font-medium">Entre vos apps Veridian</p>
          <p className="text-sm text-muted-foreground">Ce que vos apps font l&apos;une dans l&apos;autre, actif par défaut.</p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/dashboard/liaisons">Voir</Link>
        </Button>
      </Card>
      <p className="text-sm text-muted-foreground">
        Vous vous connectez chez le service lui-même : Veridian ne voit jamais votre mot de passe. L&apos;accès est à vous seul, chiffré, en lecture seule tant que vous n&apos;allumez pas l&apos;écriture.
      </p>
    </div>
  );
}

function Service({ s, ouvert }: { s: EtatConnexion; ouvert: boolean }) {
  const compte = (nom: string | null) => nom ?? 'nom non donné par le service';
  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-medium">{s.nom}</p>
          <p className="text-sm text-muted-foreground">
            {s.etat === 'a_rebrancher' ? 'À rebrancher : ce service ne vous reconnaît plus.' : s.texte}
          </p>
          {s.etat !== 'absente' ? <p className="text-sm text-muted-foreground">Compte relié : {compte(s.compte)}.{s.relu ? (s.ecriture ? ' Lecture et écriture.' : ' Lecture seule.') : ' Ses outils attendent notre relecture : votre IA n\'en voit aucun.'}</p> : null}
        </div>
        <div className="flex shrink-0 gap-2">
          {ouvert && s.etat !== 'active' && !s.attente ? <Geste cle={s.cle} nom={s.nom} geste="brancher" dit="Brancher">{s.etat === 'a_rebrancher' ? 'Rebrancher' : 'Brancher'}</Geste> : null}
          {s.etat !== 'absente' && s.ecriture ? <Geste cle={s.cle} nom={s.nom} geste="eteindre" dit="Éteindre l'écriture de">Éteindre l&apos;écriture</Geste> : null}
          {ouvert && s.etat === 'active' && s.saitEcrire && !s.ecriture ? <Geste cle={s.cle} nom={s.nom} geste="allumer" dit="Allumer l'écriture de">Allumer l&apos;écriture</Geste> : null}
          {s.etat !== 'absente' ? <Geste cle={s.cle} nom={s.nom} geste="couper" dit="Couper">Couper</Geste> : null}
        </div>
      </div>
      {s.attente ? (
        <div role="alert" className="space-y-3 rounded-md border border-border p-4">
          <p className="text-sm">
            Vous venez d&apos;autoriser un compte {s.nom} alors qu&apos;un autre est déjà relié. Relié : {compte(s.compte)}. Nouveau : {compte(s.attente.compte)}. Nous ne pouvons pas vérifier que c&apos;est le même.
          </p>
          <div className="flex gap-2">
            {ouvert ? <Geste cle={s.cle} nom={s.nom} geste="remplacer" dit="Prendre le nouveau compte de">Prendre le nouveau</Geste> : null}
            <Geste cle={s.cle} nom={s.nom} geste="garder" dit="Garder le compte actuel de">Garder l&apos;actuel</Geste>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Geste({ cle, nom, geste, dit, children }: { cle: string; nom: string; geste: string; dit: string; children: React.ReactNode }) {
  return (
    <form method="post" action="/api/connecteurs">
      <input type="hidden" name="connecteur" value={cle} />
      <input type="hidden" name="geste" value={geste} />
      <Button type="submit" size="sm" variant={geste === 'brancher' || geste === 'remplacer' ? 'default' : 'outline'} aria-label={`${dit} ${nom}`}>{children}</Button>
    </form>
  );
}
