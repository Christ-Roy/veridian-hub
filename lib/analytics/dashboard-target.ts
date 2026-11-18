/**
 * Cible de la carte « Veridian Analytics » du tableau de bord.
 *
 * LE PROBLÈME QUE ÇA RÉSOUT
 * -------------------------
 * Jusqu'ici la carte envoyait tout le monde sur la même URL : soit une valeur
 * figée dans `tenant.metadata.analytics.fallback_url` au moment du
 * provisioning, soit la racine de l'app. Deux conséquences :
 *
 *   1. Le client atterrissait sur la racine et devait retrouver son site
 *      lui-même, alors que le Hub aurait pu l'y emmener directement.
 *   2. La valeur en base ne bougeait plus jamais. Quand l'application
 *      d'analytics a changé de génération (2026-08-18), les tenants qui
 *      portaient une metadata sont restés pointés sur l'ancien moteur malgré
 *      la bascule de l'environnement — l'écart est resté invisible parce que
 *      rien ne relisait cette donnée.
 *
 * LE PRINCIPE RETENU : la correspondance est DÉRIVÉE, jamais stockée.
 *
 * L'application d'analytics est seule propriétaire de qui a accès à quel site.
 * Elle l'expose déjà via `GET /api/users/by-email` (HMAC Hub), qui applique
 * exactement ses propres règles d'accès : un propriétaire voit toute son
 * organisation, un membre restreint ne voit que ses sites. On lit cette
 * réponse à l'affichage plutôt que d'en recopier une photo en base. Il ne peut
 * donc plus y avoir de dérive, et un client ne peut pas se voir proposer le
 * site d'un autre — la liste vient de l'app, pour son email à lui.
 *
 * DÉGRADATION : jamais bloquante. La découverte a un budget de 2 s et ne lève
 * jamais. Si elle échoue, est vide, ou n'est pas câblée, on retombe sur le
 * comportement d'avant (metadata, puis défaut). Le pire cas est donc l'état
 * actuel, pas une page cassée.
 *
 * Cf. `lib/sync/discovery.ts` (client HMAC) et `lib/sync/types.ts`.
 */

import { discoverAppForEmail } from '@/lib/sync/discovery';
import type { DiscoveryAppResult } from '@/lib/sync/types';
import { resolveDownstreamBaseUrl } from '@/lib/invitations/attach-downstream';

/** D'où vient l'URL finalement servie — utile en debug et en test. */
export type AnalyticsTargetSource = 'discovery' | 'metadata' | 'default';

export interface AnalyticsCardTarget {
  /** URL ouverte par le bouton « Ouvrir ». */
  url: string;
  /**
   * Nom du site quand on a pu en désigner UN seul. `null` quand le compte a
   * plusieurs sites (on l'envoie alors sur la racine, à lui de choisir) ou
   * quand on n'a rien découvert.
   */
  siteName: string | null;
  /** Nombre de sites découverts pour cet email. 0 si découverte muette. */
  siteCount: number;
  source: AnalyticsTargetSource;
}

/** Dépendances injectables — la découverte réseau est remplaçable en test. */
export interface ResolveAnalyticsTargetDeps {
  discover?: typeof discoverAppForEmail;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveAnalyticsTargetInput {
  /** Email du user connecté. Absent → on saute la découverte. */
  email?: string | null;
  /** Jointure Hub du user connecté : l'app la préfère à l'adresse (compte à une autre adresse). */
  hubUserId?: string | null;
  /** `tenant.metadata.analytics.fallback_url`, s'il existe. */
  metadataFallbackUrl?: string | null;
  /** `tenant.metadata.analytics.tenant_name`, s'il existe. */
  metadataTenantName?: string | null;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Ne garde que les sites réellement ouvrables : il faut une `fallbackUrl`
 * fournie par l'app, et le site ne doit pas être supprimé côté app. On
 * n'invente jamais l'URL à partir de l'identifiant — c'est l'app qui sait
 * comment ses sites s'adressent, pas le Hub.
 */
function usableSnapshots(result: DiscoveryAppResult) {
  if (!('found' in result) || !result.found) return [];
  return result.snapshots.filter(
    (s) => typeof s.fallbackUrl === 'string' && s.fallbackUrl.length > 0 && s.status !== 'deleted',
  );
}

/**
 * Résout la cible de la carte Analytics pour l'utilisateur connecté.
 *
 * Ordre de préférence :
 *   1. Découverte live auprès de l'app — la seule source qui connaisse les
 *      droits réels. Un site → on y va directement. Plusieurs → racine.
 *   2. `metadata.analytics.fallback_url` — photo historique du provisioning.
 *      Conservée pour ne pas régresser sur les tenants provisionnés avant la
 *      découverte, mais elle n'est plus prioritaire.
 *   3. Le résolveur d'URL partagé.
 */
export async function resolveAnalyticsCardTarget(
  input: ResolveAnalyticsTargetInput,
  deps: ResolveAnalyticsTargetDeps = {},
): Promise<AnalyticsCardTarget> {
  const env = deps.env ?? process.env;
  const discover = deps.discover ?? discoverAppForEmail;
  const baseUrl = resolveDownstreamBaseUrl('analytics', env);

  if (input.email) {
    let sites: ReturnType<typeof usableSnapshots> = [];
    try {
      sites = usableSnapshots(await discover('analytics', input.email, { hubUserId: input.hubUserId }));
    } catch {
      // `discoverAppForEmail` ne lève pas, mais on ne parie pas le tableau de
      // bord d'un client là-dessus : toute surprise retombe sur le fallback.
      sites = [];
    }

    if (sites.length === 1) {
      return {
        url: trimTrailingSlash(sites[0].fallbackUrl as string),
        siteName: sites[0].workspaceName ?? null,
        siteCount: 1,
        source: 'discovery',
      };
    }

    if (sites.length > 1) {
      // Plusieurs sites : on n'en privilégie aucun, la racine de l'app les
      // liste déjà avec ses propres contrôles d'accès.
      return { url: baseUrl, siteName: null, siteCount: sites.length, source: 'discovery' };
    }
  }

  // L'ancien moteur répond 404 (mesuré le 07/11) : une photo qui y pointe ne vaut plus rien.
  if (input.metadataFallbackUrl && !input.metadataFallbackUrl.includes('analytics-engine.')) {
    return {
      url: trimTrailingSlash(input.metadataFallbackUrl),
      siteName: input.metadataTenantName ?? null,
      siteCount: 0,
      source: 'metadata',
    };
  }

  return { url: baseUrl, siteName: null, siteCount: 0, source: 'default' };
}
