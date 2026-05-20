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
    // Idempotence : si déjà existant, on ne touche pas — on retourne tel quel.
    // Cas spécial : si supabaseUserId manquant (rare, legacy), on le backfill.
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

  // Nouveau user : génère un UUID v4 si pas fourni.
  const supabaseUserId = input.supabaseUserId ?? randomUUID();
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
}
