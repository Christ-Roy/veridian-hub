import type { TestResidue } from '@/lib/sync/test-residue';
/**
 * Types partagés pour la stratégie de synchronisation tenants Hub ↔ apps.
 *
 * Implémente le ticket `todo/2026-05-20-tenant-sync-strategy.md` — 3 niveaux :
 *   - Niveau 1 (pull discovery)  → `lib/sync/discovery.ts`
 *   - Niveau 2 (push webhook)    → `lib/webhooks/*-handlers.ts`
 *   - Niveau 3 (cron reconcile)  → `lib/sync/reconcile.ts`
 *
 * Le snapshot d'un tenant côté app downstream est volontairement minimal :
 * on stocke ce qui est observable et exploitable par Hub (status, plan,
 * suspended flags, owner). Les colonnes business (lead_score, quota usage)
 * restent côté app — Hub n'est pas un data warehouse.
 */

/** Identifiant d'une app downstream gérée par le sync. */
export type SyncApp = 'notifuse' | 'prospection' | 'analytics' | 'crm';

// Le CMS (Payload) n'en fait pas partie : il reste à part, sans discovery ni
// secret HMAC côté Hub, et il s'éteint peu à peu (décision Robert, 06/11).
export const SYNC_APPS: readonly SyncApp[] = [
  'notifuse',
  'prospection',
  'analytics',
  'crm',
] as const;

/**
 * Snapshot d'un tenant tel qu'observé côté app downstream à l'instant T.
 * Renvoyé par `GET /api/users/by-email` ou agrégé par discoverUserApps.
 */
export interface TenantSnapshot {
  /** App à laquelle ce snapshot appartient. */
  app: SyncApp;
  /** ID du tenant côté app (slug, uuid, etc.) — sémantique app-spécifique. */
  workspaceId: string;
  workspaceName?: string;
  /** Id du tenant côté app, quand elle l'expose (Prospection). */
  tenantId?: string;
  /**
   * Tenant Hub auquel l'app a relié ce workspace (claim `tenant_id` du JWT MCP). `undefined` : l'app
   * ne rend pas le champ ; `null` : elle le rend, aucun lien.
   */
  hubTenantLink?: string | null;
  role?: string;
  plan?: string;
  /**
   * Statut d'essai stocké par l'app (`lib/plans/trial-status.ts`). `undefined` : l'app ne rend pas le
   * champ (non câblé) ; `null` : elle le rend mais n'en a reçu aucun.
   */
  trialStatus?: string | null;
  status?: 'active' | 'suspended' | 'deleted';
  magicLinkCapable?: boolean;
  /** Fallback URL si magic link n'est pas dispo (login natif de l'app). */
  fallbackUrl?: string;
  /** Quand le snapshot a été récupéré côté Hub (ISO 8601). */
  observedAt: string;
}

/** Result d'un appel discovery pour UNE app. */
export type DiscoveryAppResult =
  | { found: true; snapshots: TenantSnapshot[] }
  | { found: false }
  | { error: string; httpStatus?: number };

/** Result agrégé d'un appel discovery cross-app. */
export interface DiscoveryResult {
  /** Email du user dont on a fait le discovery. */
  email: string;
  /** Map app → result. Toujours présente pour les apps gérées. */
  apps: Record<SyncApp, DiscoveryAppResult>;
  /** ISO 8601 — quand la discovery a été lancée. */
  startedAt: string;
  /** Durée totale de l'opération (parallèle). */
  durationMs: number;
}

/** Audit d'identité d'une app (`lib/sync/identity-audit.ts`). */
export interface IdentityAuditApp {
  status: 'ok' | 'endpoint_missing' | 'unreachable' | 'not_configured';
  localAccounts: number;
  /** Comptes humains locaux dont l'adresse est inconnue du Hub. */
  withoutHub: string[];
  /** Adresse connue ET prouvée au Hub, pas encore reliée par `hub_user_id` : reliée au prochain rebond. */
  unlinked: string[];
  /**
   * Adresse connue du Hub mais NON prouvée : le Hub envoie la preuve à la prochaine ouverture d'une app
   * (`denyUnlessEmailProven`), puis le rebond relie le compte. En attente, pas une dérive muette.
   */
  awaitingProof: string[];
  emailMismatch: string[];
  nameMismatch: string[];
}

export type IdentityAudit = Partial<Record<SyncApp, IdentityAuditApp>>;

/** Type d'écart détecté par la reconciliation entre Hub et app downstream. */
export type DriftKind =
  | 'plan_mismatch'        // Hub.<app>Plan ≠ snapshot.plan
  | 'status_mismatch'      // Hub local status ≠ snapshot.status
  | 'tenant_missing_app'   // Hub croit que l'app existe, snapshot 404
  | 'tenant_extra_app'     // app a un workspace, Hub n'a pas la trace
  | 'app_unreachable'      // app down (5xx, timeout)
  | 'trial_mismatch'       // statut d'essai du Hub ≠ celui stocké par l'app
  | 'plan_unset'           // analytics / crm : app activée au Hub, aucun plan posé
  | 'hub_tenant_unlinked'; // l'app rend son lien au tenant Hub, absent ou vers un autre tenant

/** Un drift détecté par le cron reconcile pour un (tenant, app). */
export interface TenantDrift {
  hubTenantId: string;
  app: SyncApp;
  kind: DriftKind;
  hubValue: unknown;
  appValue: unknown;
  observedAt: string;
  /** Ce qu'il faut faire, en une commande quand c'est possible. Jamais d'adresse client. */
  remediation?: string;
}

/** Summary d'un run de reconciliation (renvoyé par la route cron). */
export interface ReconcileSummary {
  /** Nombre de users actifs scannés. */
  usersScanned: number;
  /**
   * Tenants actifs dont le User n'existe plus : ils n'ont pas d'email, donc la
   * discovery ne peut pas les lire. Remontés ici pour ne pas disparaître du relevé.
   */
  tenantsWithoutUser: string[];
  /** Comptes des apps comparés au Hub. Absent si l'audit n'a pas pu tourner. */
  identity?: IdentityAudit;
  /** Comptes de test et tenants orphelins encore en base (mesure seule). */
  testResidue?: TestResidue;
  /** Nombre d'apps interrogées (≤ usersScanned × 3). */
  appsQueried: number;
  /** Nombre de drifts détectés (1 drift = 1 (tenant, app) divergent). */
  driftsDetected: number;
  /** Détail des drifts (max 200 pour limiter la taille de réponse). */
  drifts: TenantDrift[];
  /** Nombre d'apps unreachable (timeout / 5xx) au moment du run. */
  appsUnreachable: number;
  /** ISO 8601 — début du run. */
  startedAt: string;
  /** Durée totale du run en ms. */
  durationMs: number;
  /** Mode de fonctionnement : pour démarrer on est en dry-run uniquement. */
  mode: 'dry-run' | 'auto-repair';
  /** Erreurs non-bloquantes rencontrées pendant le run. */
  errors: Array<{ tenantId?: string; app?: SyncApp; message: string }>;
  /**
   * Ce qui n'est pas encore branché, mesuré à chaque run (ou connu et daté) : « ce qui manque » se
   * lit ici, pas dans la mémoire de quelqu'un.
   */
  notWired: string[];
}
