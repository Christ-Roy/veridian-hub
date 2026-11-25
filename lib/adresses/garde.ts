/**
 * Une seule garde pour TOUT changement d'adresse principale par la personne : la promotion (AD-M3) et les réglages (« Votre email »). Elle passe avant
 * le moindre changement.
 */
import { pushUserToApps } from '@/lib/identity/push-user';
import { configuredSyncApps, discoverAppForEmail } from '@/lib/sync/discovery';
import type { SyncApp } from '@/lib/sync/types';

/**
 * Ces apps désignent encore quelqu'un par son ADRESSE. Mail : retirer, changer le rôle, rétablir un membre. CRM : retirer un membre, et le propriétaire
 * d'un espace noté par l'adresse du jour de la création. Academy : les inscriptions, donc les preuves de formation, rattachées par celle du stagiaire.
 * Porte de sortie : l'app lit `hub_user_id` partout (CONTRAT-HUB §5.19.7) et sort d'ici. Pour Mail, `tenants.notifuseUserEmail` (entrée directe) devra
 * suivre dans la promotion.
 */
export const APPS_PAR_ADRESSE: readonly SyncApp[] = ['notifuse', 'crm', 'academy'];

export type RefusApp = 'app_par_adresse' | 'app_non_reliee' | 'app_indisponible';
export type Arret = { refus: RefusApp; apps: SyncApp[] };

const NOM: Record<SyncApp, string> = { notifuse: 'Mail', crm: 'le CRM', academy: 'Academy', prospection: 'Atlas', analytics: 'Analytics' };

/** Ce que la personne lit : pourquoi, et que rien n'a changé. */
export function direArret(a: Arret): string {
  const noms = a.apps.map((x) => NOM[x]);
  const qui = noms.length > 1 ? `${noms.slice(0, -1).join(', ')} et ${noms.at(-1)}` : noms[0];
  const pluriel = noms.length > 1;
  const raison = {
    app_par_adresse: `${qui} vous ${pluriel ? 'reconnaissent' : 'reconnaît'} encore par votre adresse et ne ${pluriel ? 'suivraient' : 'suivrait'} pas ce changement.`,
    app_non_reliee: `${qui} ne vous ${pluriel ? 'connaissent' : 'connaît'} que par votre adresse actuelle. Ouvrez une fois cette application depuis le tableau de bord, puis réessayez.`,
    app_indisponible: `${qui} ne ${pluriel ? 'répondent' : 'répond'} pas. Réessayez plus tard.`,
  }[a.refus];
  const phrase = raison[0].toUpperCase() + raison.slice(1);
  return `${phrase} Rien n'a changé : votre adresse actuelle continue de marcher partout.`;
}

/**
 * Son compte dans chaque app : relié au Hub, connu par sa seule adresse (changer celle-ci le perdrait, et en ferait naître un double), ou absent. Une
 * app qui ne répond pas : on ne sait pas, donc on ne change rien. Rend l'arrêt, ou les apps reliées, qui suivront par `hub_user_id`.
 */
export async function verifierApps(u: { hubUserId: string | null; email: string }, deps: { fetchImpl?: typeof fetch; apps?: readonly SyncApp[] } = {}): Promise<Arret | { reliees: SyncApp[] }> {
  const apps = deps.apps ?? configuredSyncApps();
  // Sans champ à écrire, `users/sync` ne change rien : il dit seulement si ce compte existe.
  const relies = u.hubUserId ? await pushUserToApps({ hubUserId: u.hubUserId }, { apps, fetchImpl: deps.fetchImpl }) : {};
  const vus = await Promise.all(apps.map(async (app) => {
    if (relies[app] === 'ok') return { app, etat: 'reliee' };
    if (u.hubUserId && relies[app] !== 'not_in_app') return { app, etat: 'muette' };
    const d = await discoverAppForEmail(app, u.email, { fetchImpl: deps.fetchImpl });
    return { app, etat: 'error' in d ? 'muette' : d.found ? 'non_reliee' : 'absente' };
  }));
  const chez = (...etats: string[]): SyncApp[] => vus.filter((x) => etats.includes(x.etat)).map((x) => x.app);
  const parAdresse = chez('reliee', 'non_reliee').filter((a) => APPS_PAR_ADRESSE.includes(a));
  if (parAdresse.length) return { refus: 'app_par_adresse', apps: parAdresse };
  if (chez('non_reliee').length) return { refus: 'app_non_reliee', apps: chez('non_reliee') };
  if (chez('muette').length) return { refus: 'app_indisponible', apps: chez('muette') };
  return { reliees: chez('reliee') };
}
