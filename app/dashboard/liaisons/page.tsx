// /dashboard/liaisons : les liaisons entre apps, espace par espace (VER-245). Voir, allumer, couper, sans IA. Adresse stable : les apps y
// renvoient. Mêmes règles que l'outil `hub.integrations_regler` : seul le propriétaire ouvre, propriétaire et admin coupent.
import { redirect } from 'next/navigation';

import { Link2Icon } from 'lucide-react';

import { auth } from '@/auth';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { listerIntegrations, roleAuHub, type EtatPaire } from '@/lib/delegation/interrupteur';
import { espacesDe } from '@/lib/mcp/catalogue';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const AVIS: Record<string, string> = {
  allumee: 'Liaison allumée.',
  eteinte: 'Liaison coupée.',
  role_insuffisant: 'Seul le propriétaire ou un administrateur de cet espace règle ses liaisons.',
  cible_non_servie: 'Cette liaison n\'est pas encore disponible.',
  paire_inconnue: 'Cette liaison n\'existe pas.',
  refus: 'Réglage refusé. Rechargez la page.',
};

function Reglage({ tenant, l }: { tenant: string; l: EtatPaire }) {
  const allumee = l.etat === 'allumee';
  return (
    <form method="post" action="/api/integrations/regler">
      <input type="hidden" name="tenant" value={tenant} />
      <input type="hidden" name="paire" value={l.paire} />
      <input type="hidden" name="etat" value={allumee ? 'eteinte' : 'allumee'} />
      <Button type="submit" variant={allumee ? 'outline' : 'default'}>{allumee ? 'Couper' : 'Allumer'}</Button>
    </form>
  );
}

const ERREURS: Record<string, string> = {
  crm_injoignable: 'le CRM ne répond pas, nouvel essai automatique',
  crm_app_not_available: 'l\'app Liaisons n\'est pas disponible dans ce CRM',
  crm_app_uninstalled: 'l\'app Liaisons a été désinstallée du CRM',
  crm_app_installing: 'l\'app Liaisons s\'installe dans le CRM, nouvel essai automatique',
  crm_app_install_failed: 'l\'app Liaisons n\'a pas pu s\'installer dans le CRM, nouvel essai automatique',
  crm_tenant_not_linked: 'cet espace n\'est pas relié au CRM',
  crm_workspace_inactive: 'l\'espace du CRM est inactif',
  pause_disjoncteur: 'liaison en pause, trop d\'écritures sur un même contact',
};

export default async function Liaisons({ searchParams }: { searchParams: Promise<{ avis?: string }> }) {
  const session = await auth();
  const user = session ? await getCurrentUser() : null;
  if (!user) redirect('/login?callbackUrl=/dashboard/liaisons');
  const hubUserId = userUuid(user);
  const avis = AVIS[(await searchParams).avis ?? ''];
  const espaces = await Promise.all(
    (await espacesDe(prisma, hubUserId)).map(async (e) => ({
      ...e,
      au: await roleAuHub(prisma, e.id, hubUserId),
      liaisons: (await listerIntegrations(prisma, e.id)).filter((l) => l.etat !== 'indisponible'),
    })),
  );
  const visibles = espaces.filter((e) => e.liaisons.length > 0);
  return (
    <div className="flex flex-col gap-6 p-4 md:p-8">
      <DashboardPageHeader title="Liaisons" icon={Link2Icon} description="Ce que vos apps font l'une dans l'autre. Rien n'est jamais supprimé, aucun mail n'est envoyé." />
      {avis ? <p role="status" className="text-sm">{avis}</p> : null}
      {visibles.length === 0 ? <p className="text-muted-foreground">Aucune liaison n&apos;est encore disponible pour vos espaces.</p> : null}
      {visibles.map((e) => {
        const regle = e.au === 'owner' || e.au === 'admin';
        return (
          <Card key={e.id}>
            <CardHeader>
              <CardTitle>{e.nom}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {e.liaisons.map((l) => (
                <div key={l.paire} className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{l.libelle}</p>
                    <p className="text-sm text-muted-foreground">
                      {l.etat === 'allumee' ? 'Allumée' : 'Éteinte'}
                      {l.dernier_passage ? `, dernier passage le ${new Date(l.dernier_passage).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}` : ''}
                      {l.derniere_erreur ? `, dernière erreur : ${ERREURS[l.derniere_erreur] ?? l.derniere_erreur}` : ''}
                    </p>
                  </div>
                  {regle && (l.etat === 'allumee' || l.consentie || e.au === 'owner') ? <Reglage tenant={e.id} l={l} /> : <p className="text-sm text-muted-foreground">Le propriétaire peut l&apos;allumer</p>}
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
