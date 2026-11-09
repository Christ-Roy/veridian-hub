/**
 * Cibles de la batterie système. Prod par défaut : la batterie vérifie ce qui
 * est SERVI, pas ce qui est mergé. Chaque URL se surcharge par l'environnement.
 */
export type AppKey = 'prospection' | 'notifuse' | 'analytics' | 'twenty';

export const HUB_URL = process.env.HUB_URL || 'https://app.veridian.site';

export const APP_URL: Record<AppKey, string> = {
  prospection: process.env.PROSPECTION_URL || 'https://prospection.app.veridian.site',
  notifuse: process.env.NOTIFUSE_URL || 'https://notifuse.app.veridian.site',
  analytics: process.env.ANALYTICS_URL || 'https://analytics.app.veridian.site',
  // Twenty : suit le Hub. Prod = crm.app.veridian.site (CRM_API_URL du job hub) ; staging sinon.
  // 09/11 : un défaut staging sur un Hub prod faisait échouer l'arrivée Twenty (refus d'un next hors liste).
  twenty: process.env.TWENTY_URL || twentyPar(process.env.HUB_URL || 'https://app.veridian.site'),
};

/** Hôte Twenty d'un Hub donné : staging si le Hub est staging, prod sinon. Pur, testé en CI. */
export function twentyPar(hub: string): string {
  return /staging/.test(hub) ? 'https://crm.staging.veridian.site' : 'https://crm.app.veridian.site';
}

/**
 * Nom Nomad du job de chaque app. `corrige` ne sert qu'au Hub (version minimale). `avant` liste
 * les images d'app anterieures au correctif : seules elles rendent un echec « attendu rouge ».
 */
export const SERVI: Record<
  'hub' | AppKey,
  { job: string | null; corrige: string[]; avant: string[]; note: string }
> = {
  hub: {
    job: 'hub',
    corrige: ['v0.5.49'],
    avant: [],
    note: 'preuve d\'adresse, rebond sur les hôtes réels, synchro d\'identité',
  },
  prospection: { job: 'prospection', corrige: [], avant: [], note: 'identité Hub' },
  notifuse: { job: 'notifuse', corrige: [], avant: [], note: 'identité Hub' },
  analytics: { job: 'analytics-rybbit', corrige: [], avant: [], note: 'identité Hub (Rybbit)' },
  twenty: { job: null, corrige: [], avant: [], note: 'staging, si servi' },
};

/** Libellé et préfixe de tous les comptes de test créés par la batterie. */
export const PREFIXE_COMPTE = 'e2e-sso-';
export const DOMAINE_COMPTE = 'veridian.site';

/** Masque les jetons à usage unique avant tout affichage. */
export function masquer(s: string): string {
  return s
    .replace(/([?&](?:token|t|code)=)[^&\s"')]+/gi, '$1…')
    .replace(/\/onboard\/[A-Za-z0-9_-]+/g, '/onboard/…');
}
