// Les apps d'une organisation, vues par un salarié (VER-261) : celles qu'elle a ouvertes, rien à démarrer, rien à payer.
import { lienApp } from '@/lib/apps/lien-app';
import type { OrganisationSeule } from '@/lib/tenants/membre-seul';

import { ServiceCard, type ServiceCardIcon } from './ServiceCard';
import type { AppKey } from './AppIdentity';

const APPS: Record<string, { nom: string; texte: string; icone: ServiceCardIcon; cle: AppKey }> = {
  crm: { nom: 'CRM', texte: 'Les contacts, sociétés et affaires de votre organisation.', icone: 'Users', cle: 'crm' },
  notifuse: { nom: 'Mail', texte: 'Les emails et campagnes de votre organisation.', icone: 'Mail', cle: 'mail' },
  prospection: { nom: 'Prospection', texte: 'Les recherches et listes de votre organisation.', icone: 'Globe', cle: 'prospection' },
  academy: { nom: 'Academy', texte: 'Les formations de votre organisation.', icone: 'GraduationCap', cle: 'academy' },
};

/** Les apps ouvertes par l'organisation. Academy reste réservée aux comptes activés. */
export function outilsDe(o: OrganisationSeule, academyActivee: boolean, env: NodeJS.ProcessEnv = process.env): { cle: string; url: string }[] {
  return o.modules.flatMap((cle) => {
    const url = lienApp(cle, env);
    return !url || (cle === 'academy' && !academyActivee) ? [] : [{ cle, url }];
  });
}

export function OutilsOrganisation({ organisations, academyActivee }: { organisations: OrganisationSeule[]; academyActivee: boolean }) {
  return (
    <>
      {organisations.map((o) => {
        const outils = outilsDe(o, academyActivee);
        return (
          <section key={o.id} className="mb-12" aria-label={o.nom}>
            <h2 className="mb-4 text-2xl font-semibold tracking-tight">{o.nom}</h2>
            {outils.length === 0 ? (
              <p className="text-sm text-muted-foreground">Votre organisation n&apos;a pas encore ouvert d&apos;application. Demandez à son responsable.</p>
            ) : (
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                {outils.map(({ cle, url }) => <ServiceCard key={cle} name={`Veridian ${APPS[cle].nom}`} description={APPS[cle].texte} url={url} icon={APPS[cle].icone} appKey={APPS[cle].cle} />)}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
