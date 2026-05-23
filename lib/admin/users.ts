/**
 * Helpers admin pour le provisioning manuel des users Hub.
 *
 * Architecture :
 *  - User.id : cuid string (généré par Prisma)
 *  - User.supabaseUserId : UUID v4 legacy bridge utilisé comme `user_id`
 *    côté Notifuse / Prospection / CMS / Analytics. C'est CE champ qui
 *    fait le pont vers les apps downstream.
 *
 * Si Robert provisionne manuellement un user via skill (cms-provision,
 * etc.), on a besoin :
 *  1. Que le user Hub existe (sinon dashboard vide)
 *  2. Qu'il ait un `supabaseUserId` UUID pour la corrélation cross-app
 *
 * `upsertHubUser` garantit ces 2 invariants en idempotent : si le user
 * existe déjà (par email), on retourne ses IDs ; sinon on le crée avec
 * un UUID frais. Aucune écriture si déjà aligné.
 *
 * **Race-safety** : findUnique → create n'est PAS atomique. Si deux
 * appels concurrents passent findUnique simultanément avec un email
 * non-encore-créé, les deux tentent create → la 2e plante avec
 * P2002 (unique constraint). On catch P2002 → relit le user → retourne
 * already_existed. Spec 13 S5 E2E : 5 calls simultanés sur le même
 * email = 1 created + 4 already_existed, jamais 500.
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export type UpsertHubUserInput = {
  email: string;
  name?: string;
  /**
   * Si fourni, on l'utilise comme supabaseUserId (utile quand un agent
   * IA a déjà créé l'identité côté app downstream et veut aligner).
   * Sinon on génère un UUID v4 frais via node:crypto.
   */
  supabaseUserId?: string;
};

export type UpsertHubUserResult = {
  userId: string; // User.id cuid
  supabaseUserId: string; // User.supabaseUserId UUID
  email: string;
  created: boolean; // true si on a inséré, false si déjà existant
  alreadyExisted: boolean; // miroir de !created, plus parlant côté API JSON
  /**
   * true uniquement si on a hit P2002 sur create et résolu via findUnique
   * post-race. Sert au monitoring / tests pour distinguer
   * "already_existed avant race" de "already_existed résolu par race".
   * Non exposé dans la réponse JSON publique (créerait du bruit côté
   * clients) — usage interne audit / tests Nuclear.
   */
  raceConditionResolved?: boolean;
};

export async function upsertHubUser(
  prisma: PrismaClient,
  input: UpsertHubUserInput
): Promise<UpsertHubUserResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new Error('email is required');

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, supabaseUserId: true, name: true },
  });

  if (existing) {
    return backfillIfNeeded(prisma, existing, input);
  }

  // Pas de user existant : on tente le create. Pattern race-safe via
  // try/catch P2002 + relit. Plus prévisible qu'upsert (qui exécuterait
  // un UPDATE no-op sur conflit, écrasant l'updatedAt = surprise audit).
  const supabaseUserId = input.supabaseUserId ?? randomUUID();
  try {
    const created = await prisma.user.create({
      data: {
        email,
        name: input.name,
        supabaseUserId,
        // emailVerified laissé null : le user devra cliquer un magic link
        // ou se logger via OAuth pour confirmer.
      },
      select: { id: true, email: true, supabaseUserId: true },
    });

    return {
      userId: created.id,
      supabaseUserId: created.supabaseUserId!,
      email: created.email,
      created: true,
      alreadyExisted: false,
    };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== 'P2002') {
      // Autre erreur Prisma (P1001 timeout, P2024 pool, etc.) → re-throw,
      // la route route renverra 500 — pas masquer un vrai bug DB.
      throw err;
    }

    // Race : un autre appel concurrent a inséré le même email entre notre
    // findUnique et notre create. On relit, on retourne already_existed.
    // Si la relecture ne trouve rien (cas pathologique, contrainte
    // unique sur un autre champ par exemple) → re-throw l'erreur initiale,
    // pas masquer.
    const raced = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, supabaseUserId: true, name: true },
    });
    if (!raced) {
      throw err;
    }
    const result = await backfillIfNeeded(prisma, raced, input);
    return { ...result, raceConditionResolved: true };
  }
}

/**
 * Backfill `supabaseUserId` si manquant (cas legacy), puis retourne
 * `alreadyExisted=true`. Factorisé pour partager entre le chemin
 * "user trouvé avant create" et "user trouvé après race P2002".
 */
async function backfillIfNeeded(
  prisma: PrismaClient,
  existing: {
    id: string;
    email: string;
    supabaseUserId: string | null;
    name: string | null;
  },
  input: UpsertHubUserInput
): Promise<UpsertHubUserResult> {
  let supabaseUserId = existing.supabaseUserId;
  if (!supabaseUserId) {
    supabaseUserId = input.supabaseUserId ?? randomUUID();
    await prisma.user.update({
      where: { id: existing.id },
      data: { supabaseUserId },
    });
  }
  return {
    userId: existing.id,
    supabaseUserId,
    email: existing.email,
    created: false,
    alreadyExisted: true,
  };
}
