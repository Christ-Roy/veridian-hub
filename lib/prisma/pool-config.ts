/**
 * Bornes du pool `pg` du Hub (Prisma 7 via @prisma/adapter-pg). Pendant une bascule de pg-saas,
 * l'entrée HAProxy accepte le TCP sans qu'aucun primaire réponde : sans borne, pg attend sans fin
 * (délai de connexion et de requête infinis par défaut). Mesuré le 09/11 : CRM bloqué 180 s,
 * Notifuse figé jusqu'au redémarrage. Avec ces bornes, une requête échoue vite et le pool se refait
 * sur le nouveau primaire. Épreuve : __tests__/lib/prisma/pool-config.test.ts (socket muet).
 */
import type { PoolConfig } from 'pg';

export type Bornes = {
  /** Ouverture d'une connexion, et attente d'une connexion libre du pool. */
  connectTimeoutMs: number;
  /** Requête sans réponse (primaire perdu en cours de route). */
  queryTimeoutMs: number;
};

export const BORNES: Bornes = { connectTimeoutMs: 10_000, queryTimeoutMs: 60_000 };

export function poolConfig(connectionString: string, bornes: Bornes = BORNES): PoolConfig {
  return {
    connectionString,
    connectionTimeoutMillis: bornes.connectTimeoutMs,
    query_timeout: bornes.queryTimeoutMs,
    // Une connexion ne survit pas indéfiniment à une bascule : refaite au plus tard toutes les 5 min.
    maxLifetimeSeconds: 300,
    idleTimeoutMillis: 30_000,
    // Pair mort (primaire tombé sans FIN) détecté par le noyau plutôt qu'au prochain envoi.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    max: 10,
  };
}
