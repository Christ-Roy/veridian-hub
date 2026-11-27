/**
 * Quelles apps sont ouvertes pour un compte, et par où on y entre.
 * Seule vérité : la page du tableau de bord et le sélecteur d'apps de l'en-tête l'appellent toutes deux.
 * Une app ouverte : activée (apps réservées), ou provisionnée, ou servie par les notes du tenant. Academy reste réservée : sans activation, rien.
 */
import { idEspaceMeta } from '@/lib/apps/espace-note';
import { lienApp } from '@/lib/apps/lien-app';

export type CleApp = 'prospection' | 'notifuse' | 'analytics' | 'cms' | 'crm' | 'academy';

export type TenantApps = {
  prospectionProvisionedAt?: Date | string | null;
  notifuseWorkspaceSlug?: string | null;
  notifusePlan?: string | null;
  metadata?: unknown;
} | null;

type MetaApp = { fallback_url?: string; tenant_name?: string } | null;

/** Adresse du CMS quand il est activé sans note d'accès (celle que la carte ouvre). */
export const CMS_URL_PAR_DEFAUT = 'https://cms.app.veridian.site';

/** Ce que les notes du tenant disent (`metadata`), lu une seule fois. */
export function notesTenant(tenant: TenantApps) {
  const meta = (tenant?.metadata as Record<string, unknown> | null) ?? {};
  const planSource = meta.notifuse_plan_source as string | undefined;
  return {
    // §8.9.4 : plan offert « site vitrine à vie ».
    lifetimeSiteVitrine: planSource === 'lifetime_site_vitrine' || tenant?.notifusePlan === 'lifetime_site_vitrine',
    cms: (meta.cms as MetaApp) ?? null,
    analytics: (meta.analytics as MetaApp) ?? null,
  };
}

export type EntreeApps = {
  tenant: TenantApps;
  /** Apps réservées activées pour ce compte (`getEnabledGatedApps`). */
  activees: ReadonlySet<string>;
  /** Sites qu'Analytics reconnaît pour cet email (0 si muet) : en avoir un suffit à ouvrir la carte. */
  sitesAnalytics?: number;
  env?: NodeJS.ProcessEnv;
};

export type EtatApps = Record<CleApp, boolean> & { lifetimeSiteVitrine: boolean };

export function etatApps({ tenant, activees, sitesAnalytics = 0, env = process.env }: EntreeApps): EtatApps {
  const notes = notesTenant(tenant);
  const notifuseUrl = env.NOTIFUSE_API_URL || '';
  return {
    lifetimeSiteVitrine: notes.lifetimeSiteVitrine,
    prospection: !!tenant?.prospectionProvisionedAt,
    notifuse: !!tenant?.notifuseWorkspaceSlug && notifuseUrl.length > 0 && !notifuseUrl.includes('localhost'),
    // Un espace Analytics noté suffit : sans site, le client doit pouvoir entrer.
    analytics: activees.has('analytics') || notes.lifetimeSiteVitrine || !!notes.analytics?.fallback_url || !!idEspaceMeta(tenant?.metadata, 'analytics') || sitesAnalytics > 0,
    // Le CMS s'éteint : visible seulement là où il est actif, jamais proposé.
    cms: activees.has('cms') || !!notes.cms?.fallback_url || !!idEspaceMeta(tenant?.metadata, 'cms'),
    // Le CRM est ouvert à tout compte : la première ouverture crée l'espace.
    crm: !!env.CRM_API_URL,
    // Academy est réservée : activée ET branchée.
    academy: activees.has('academy') && !!env.ACADEMY_API_URL,
  };
}

export type AppOuverte = { cle: CleApp; nom: string; href: string };

const NOMS: Record<CleApp, string> = {
  prospection: 'Prospection',
  notifuse: 'Mail',
  analytics: 'Analytics',
  cms: 'CMS',
  crm: 'CRM',
  academy: 'Academy',
};
const ORDRE: CleApp[] = ['prospection', 'notifuse', 'analytics', 'cms', 'crm', 'academy'];

/**
 * Les apps ouvertes avec leur lien. CRM, Mail, Prospection, Academy : le rebond signé (`lienApp`), jamais un jeton.
 * Analytics et CMS : l'adresse que la carte du tableau de bord ouvre déjà (`analyticsUrl`), faute de rebond déclaré pour elles.
 */
export function appsOuvertes(entree: EntreeApps, analyticsUrl: string | null = null): AppOuverte[] {
  const etat = etatApps(entree);
  const env = entree.env ?? process.env;
  return ORDRE.flatMap((cle) => {
    if (!etat[cle]) return [];
    const href = cle === 'analytics' ? analyticsUrl : cle === 'cms' ? notesTenant(entree.tenant).cms?.fallback_url ?? CMS_URL_PAR_DEFAUT : lienApp(cle, env);
    return href ? [{ cle, nom: NOMS[cle], href }] : [];
  });
}
