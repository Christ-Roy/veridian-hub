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
export type SyncApp = 'notifuse' | 'prospection' | 'analytics' | 'cms';

export const SYNC_APPS: readonly SyncApp[] = [
  'notifuse',
  'prospection',
  'analytics',
  'cms',
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
  role?: string;
  plan?: string;
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
  /** Map app → result. Toujours présente pour les 4 apps gérées. */
  apps: Record<SyncApp, DiscoveryAppResult>;
  /** ISO 8601 — quand la discovery a été lancée. */
  startedAt: string;
  /** Durée totale de l'opération (parallèle). */
  durationMs: number;
}

/** Type d'écart détecté par la reconciliation entre Hub et app downstream. */
export type DriftKind =
  | 'plan_mismatch'        // Hub.<app>Plan ≠ snapshot.plan
  | 'status_mismatch'      // Hub local status ≠ snapshot.status
  | 'tenant_missing_app'   // Hub croit que l'app existe, snapshot 404
  | 'tenant_extra_app'     // app a un workspace, Hub n'a pas la trace
  | 'app_unreachable';     // app down (5xx, timeout)

/** Un drift détecté par le cron reconcile pour un (tenant, app). */
export interface TenantDrift {
  hubTenantId: string;
  app: SyncApp;
  kind: DriftKind;
  hubValue: unknown;
  appValue: unknown;
  observedAt: string;
}

/** Summary d'un run de reconciliation (renvoyé par la route cron). */
export interface ReconcileSummary {
  /** Nombre de users actifs scannés. */
  usersScanned: number;
  /** Nombre d'apps interrogées (≤ usersScanned × 4). */
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
}
