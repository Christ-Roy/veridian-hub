/**
 * Compteurs à fenêtre glissante partagés entre instances (VER-270, dérogation deux instances).
 *
 * Approximation standard à deux fenêtres : la fenêtre courante (compte réel) et la précédente pèsent selon ce qui reste de la
 * fenêtre courante. compte ≈ courante + précédente × (1 − écoulé / fenêtre). Une rafale à cheval sur la frontière de deux
 * fenêtres ne passe donc plus deux fois le plafond.
 *
 * Chaque appel fait UNE écriture atomique : `INSERT … ON CONFLICT DO UPDATE` sur la fenêtre courante, dans la même requête qui
 * lit la précédente (CTE). Deux instances qui frappent la même clé se voient dans la même table, sans lecture intermédiaire.
 *
 * Clé hachée (SHA-256) : une adresse e-mail visée n'est jamais stockée en clair. Ménage borné : les lignes expirées sont retirées
 * au plus tous les FENETRE_MENAGE_TOUS appels par processus, 1000 lignes au plus par passage.
 *
 * Panne de base : l'appelant reçoit une erreur. Les limiteurs la transforment en refus (fermé) et la journalisent ; jamais un passage.
 */
import { createHash } from 'node:crypto';

import { prisma } from '@/lib/prisma';

export type Fenetres = { courante: number; precedente: number };

export type Magasin = {
  /**
   * Incrémente la fenêtre courante et rend les deux comptes (courante après incrément, précédente avant). Une seule écriture.
   * `debutPrecedenteMs` = début de la fenêtre précédente ; `expireLe` = fin de la courante.
   */
  incrementer(limiteur: string, cle: string, debutMs: number, debutPrecedenteMs: number, expireLe: Date): Promise<Fenetres>;
  /** Lit les deux comptes sans les modifier (0 si absents). */
  lire(limiteur: string, cle: string, debutMs: number, debutPrecedenteMs: number): Promise<Fenetres>;
  /** Retire toutes les fenêtres d'un limiteur (tests uniquement). */
  vider(limiteur: string): Promise<void>;
  /** Retire les fenêtres expirées avant `avant`, 1000 au plus. */
  menage(avant: Date): Promise<void>;
};

export const FENETRE_MENAGE_TOUS = 128;

export const magasinPrisma: Magasin = {
  async incrementer(limiteur, cle, debutMs, debutPrecedenteMs, expireLe) {
    const lignes = await prisma.$queryRaw<{ courante: number; precedente: number }[]>`
      WITH courante AS (
        INSERT INTO "hub_app"."compteurs_fenetre" ("limiteur", "cle", "debut_ms", "compte", "expire_le")
        VALUES (${limiteur}, ${cle}, ${BigInt(debutMs)}, 1, ${expireLe})
        ON CONFLICT ("limiteur", "cle", "debut_ms") DO UPDATE SET "compte" = "hub_app"."compteurs_fenetre"."compte" + 1
        RETURNING "compte"
      ), precedente AS (
        SELECT "compte" FROM "hub_app"."compteurs_fenetre"
        WHERE "limiteur" = ${limiteur} AND "cle" = ${cle} AND "debut_ms" = ${BigInt(debutPrecedenteMs)}
      )
      SELECT (SELECT "compte" FROM courante)::int AS "courante", COALESCE((SELECT "compte" FROM precedente), 0)::int AS "precedente"`;
    if (lignes.length !== 1) throw new Error('compteurs_fenetre : écriture sans compte rendu');
    return { courante: Number(lignes[0].courante), precedente: Number(lignes[0].precedente) };
  },
  async lire(limiteur, cle, debutMs, debutPrecedenteMs) {
    const lignes = await prisma.$queryRaw<{ debut: bigint; compte: number }[]>`
      SELECT "debut_ms" AS debut, "compte" FROM "hub_app"."compteurs_fenetre"
      WHERE "limiteur" = ${limiteur} AND "cle" = ${cle} AND "debut_ms" IN (${BigInt(debutMs)}, ${BigInt(debutPrecedenteMs)})`;
    const compte = (d: number) => Number(lignes.find((l) => Number(l.debut) === d)?.compte ?? 0);
    return { courante: compte(debutMs), precedente: compte(debutPrecedenteMs) };
  },
  async vider(limiteur) {
    await prisma.$executeRaw`DELETE FROM "hub_app"."compteurs_fenetre" WHERE "limiteur" = ${limiteur}`;
  },
  async menage(avant) {
    await prisma.$executeRaw`
      DELETE FROM "hub_app"."compteurs_fenetre"
      WHERE ctid IN (SELECT ctid FROM "hub_app"."compteurs_fenetre" WHERE "expire_le" < ${avant} LIMIT 1000)`;
  },
};

/** Magasin des tests unitaires (mock de __tests__/setup.ts) : mêmes règles, en mémoire d'un seul processus. */
export function magasinEnMemoire(): Magasin {
  type Ligne = { limiteur: string; cle: string; debut: number; compte: number; expire: number };
  const lignes = new Map<string, Ligne>();
  const cle3 = (l: string, c: string, d: number) => `${l}\u0000${c}\u0000${d}`;
  const lu = (l: string, c: string, d: number) => lignes.get(cle3(l, c, d))?.compte ?? 0;
  return {
    async incrementer(limiteur, cle, debutMs, debutPrecedenteMs, expireLe) {
      const k = cle3(limiteur, cle, debutMs);
      const l = lignes.get(k) ?? { limiteur, cle, debut: debutMs, compte: 0, expire: expireLe.getTime() };
      l.compte += 1;
      lignes.set(k, l);
      return { courante: l.compte, precedente: lu(limiteur, cle, debutPrecedenteMs) };
    },
    async lire(limiteur, cle, debutMs, debutPrecedenteMs) {
      return { courante: lu(limiteur, cle, debutMs), precedente: lu(limiteur, cle, debutPrecedenteMs) };
    },
    async vider(limiteur) {
      for (const [k, l] of Array.from(lignes)) if (l.limiteur === limiteur) lignes.delete(k);
    },
    async menage(avant) {
      for (const [k, l] of Array.from(lignes)) if (l.expire < avant.getTime()) lignes.delete(k);
    },
  };
}

let magasin: Magasin = magasinPrisma;
let appels = 0;

/** Installe un autre magasin (tests). En production, le magasin PostgreSQL reste le défaut. */
export function installerMagasin(m: Magasin): void {
  magasin = m;
}

const cleHachee = (cle: string) => createHash('sha256').update(cle).digest('hex');

/** Estimation glissante : courante + précédente × (1 − écoulé / fenêtre). */
export function estimer(f: Fenetres, ecoule: number, fenetreMs: number): number {
  return f.courante + f.precedente * (1 - ecoule / fenetreMs);
}

function bornes(fenetreMs: number, now: number) {
  const debut = Math.floor(now / fenetreMs) * fenetreMs;
  return { debut, precedente: debut - fenetreMs, resetAt: debut + fenetreMs, ecoule: now - debut };
}

/** Compte la requête (incrément atomique) et rend l'estimation glissante. Lance une erreur si la base ne répond pas. */
export async function compterFenetre(limiteur: string, cle: string, fenetreMs: number, now: number): Promise<{ compte: number; resetAt: number }> {
  const b = bornes(fenetreMs, now);
  const f = await magasin.incrementer(limiteur, cleHachee(cle), b.debut, b.precedente, new Date(b.resetAt + fenetreMs));
  if (++appels % FENETRE_MENAGE_TOUS === 0) {
    magasin.menage(new Date(now)).catch((err) => console.warn('[compteurs] ménage ignoré', err instanceof Error ? err.message : err));
  }
  return { compte: estimer(f, b.ecoule, fenetreMs), resetAt: b.resetAt };
}

/** Lit l'estimation glissante sans compter. Lance une erreur si la base ne répond pas. */
export async function lireFenetre(limiteur: string, cle: string, fenetreMs: number, now: number): Promise<{ compte: number; resetAt: number }> {
  const b = bornes(fenetreMs, now);
  const f = await magasin.lire(limiteur, cleHachee(cle), b.debut, b.precedente);
  return { compte: estimer(f, b.ecoule, fenetreMs), resetAt: b.resetAt };
}

/** Remise à zéro d'un limiteur (tests). */
export function viderLimiteur(limiteur: string): Promise<void> {
  return magasin.vider(limiteur);
}
