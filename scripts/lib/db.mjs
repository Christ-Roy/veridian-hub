/**
 * Helper Postgres partagé pour les scripts opérationnels (init-stripe,
 * sync-billing, seed-dev-user, ...).
 *
 * Post-migration Auth.js / Prisma : on tape directement la base via `pg`
 * plutôt que de remonter Prisma hors Next (lourd à setup hors runtime Next).
 *
 * Tables ciblées (toutes dans le schema `hub_app`) :
 *   - hub_app.products
 *   - hub_app.prices
 *   - hub_app.users / hub_app.accounts (pour seed)
 *   - hub_app.tenants (lecture verif)
 */

import pg from 'pg';

const { Client } = pg;

export function createPgClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  return new Client({ connectionString });
}

/**
 * Exécute une fonction avec un client Postgres ouvert. Le client est
 * automatiquement fermé en sortie, succès ou erreur.
 */
export async function withPg(fn) {
  const client = createPgClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}
