/**
 * Tenant Cleanup Utilities — DISABLED
 *
 * Le cleanup automatique des tenants est désactivé.
 * Les freemium restent actifs indéfiniment — l'accès est limité côté app
 * (paywall, blur, rate limiting, obfuscation serveur).
 *
 * Les fonctions exportées sont conservées comme no-op pour ne pas casser
 * les imports existants (route cron, etc.).
 */

export interface CleanupResult {
  success: boolean;
  tenantsProcessed: number;
  tenantsDeleted: number;
  errors: string[];
}

export interface ExpiredTenant {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  notifuse_workspace_slug: string | null;
  twenty_workspace_id: string | null;
  trial_ends_at: string;
  cleanup_notified_at: string | null;
}

/** No-op — cleanup is disabled. Tenants are never deleted. */
export async function cleanupExpiredTrials(): Promise<CleanupResult> {
  console.log('[Cleanup] Cleanup is DISABLED — tenants are never deleted. Access is restricted via paywall/rate limiting.');
  return {
    success: true,
    tenantsProcessed: 0,
    tenantsDeleted: 0,
    errors: [],
  };
}

/** No-op — returns empty array. */
export async function getExpiringTrials(_daysBeforeExpiry: number = 3): Promise<ExpiredTenant[]> {
  return [];
}
