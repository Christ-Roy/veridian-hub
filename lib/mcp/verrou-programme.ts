/**
 * Verrou « un programme à la fois par compte » (VER-270), partagé entre instances du Hub.
 *
 * Mécanisme : `pg_try_advisory_lock` de session, pris sur une connexion DÉDIÉE ouverte pour la durée du programme (hors du pool
 * Prisma). Une connexion dédiée est indispensable : un verrou de session pris sur une connexion de pool passerait à une autre
 * requête à la restitution. Le verrou meurt avec sa connexion : `liberer` le rend explicitement, et une coupure d'instance, une
 * erreur ou un délai dépassé ferment la socket, que PostgreSQL traite comme une fin de session et libère.
 *
 * Coût : une connexion PostgreSQL par programme en cours (un au plus par compte). Le pool Prisma n'est pas touché.
 * Panne (connexion refusée, base muette) : refus fermé, `indisponible`. Jamais un passage.
 */
import { Client } from 'pg';

export type PriseVerrou = { ok: true; liberer: () => Promise<void> } | { ok: false; raison: 'occupe' | 'indisponible'; erreur?: string };

export type Verrou = {
  prendre(utilisateur: string): Promise<PriseVerrou>;
};

const DELAI_CONNEXION_MS = 10_000;
const DELAI_REQUETE_MS = 10_000;

/** Verrou PostgreSQL (production) : une connexion dédiée par programme. */
export const verrouPostgres: Verrou = {
  async prendre(utilisateur) {
    const url = process.env.DATABASE_URL;
    if (!url) return { ok: false, raison: 'indisponible', erreur: 'DATABASE_URL absent' };
    const client = new Client({
      connectionString: url,
      connectionTimeoutMillis: DELAI_CONNEXION_MS,
      query_timeout: DELAI_REQUETE_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      application_name: 'hub-programme',
    });
    client.on('error', (err) => console.error('[programme-verrou] connexion', err.message));
    try {
      await client.connect();
      const r = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [utilisateur]);
      if (!r.rows[0]?.ok) {
        await client.end().catch(() => undefined);
        return { ok: false, raison: 'occupe' };
      }
      return {
        ok: true,
        liberer: async () => {
          // Fermer la connexion libère le verrou de session même si le déverrouillage explicite échoue.
          try {
            await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [utilisateur]);
          } catch (err) {
            console.error('[programme-verrou] déverrouillage', err instanceof Error ? err.message : err);
          } finally {
            await client.end().catch(() => undefined);
          }
        },
      };
    } catch (err) {
      await client.end().catch(() => undefined);
      return { ok: false, raison: 'indisponible', erreur: err instanceof Error ? err.message : String(err) };
    }
  },
};

/** Verrou des tests unitaires (installé par __tests__/setup.ts) : un processus, même contrat. */
export function verrouEnMemoire(): Verrou {
  const pris = new Set<string>();
  return {
    async prendre(utilisateur) {
      if (pris.has(utilisateur)) return { ok: false, raison: 'occupe' };
      pris.add(utilisateur);
      return {
        ok: true,
        liberer: async () => {
          pris.delete(utilisateur);
        },
      };
    },
  };
}

let verrou: Verrou = verrouPostgres;

/** Installe un autre verrou (tests). En production, le verrou PostgreSQL reste le défaut. */
export function installerVerrou(v: Verrou): void {
  verrou = v;
}

export function verrouCourant(): Verrou {
  return verrou;
}
