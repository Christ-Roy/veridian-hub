/**
 * Event `createUser` Auth.js v5 — patch le user fraîchement créé par le
 * PrismaAdapter avec un `supabaseUserId` (UUID v4 stringifié).
 *
 * CONTEXTE : le flow signup Credentials (`app/api/auth/signup/route.ts`) génère
 * un `randomUUID()` et set `supabaseUserId = userUuid` pour servir de pont
 * vers `tenants.user_id` / `subscriptions.user_id` (colonnes UUID).
 *
 * Le PrismaAdapter d'Auth.js, lui, ne sait rien de cette colonne et crée le
 * user OAuth avec `supabaseUserId = NULL`. Tout helper appelant `userUuid(user)`
 * throw alors → Dashboard Layout en panne, provisioning impossible.
 *
 * Ce module factorise la logique en pure function injectable pour la tester
 * unitairement sans monter une instance NextAuth.
 *
 * Contrat de retour Auth.js v5 events : Promise<void>. Les erreurs doivent
 * être loggées mais ne pas throw (sinon casse la session).
 */

import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

type CreatedUser = {
  id?: string | null;
  email?: string | null;
};

export type CreateUserEventDeps = {
  /** Prisma client minimal (mockable) */
  prisma: Pick<PrismaClient, 'user'>;
  /** UUID factory injectable pour les tests déterministes */
  generateUuid?: () => string;
  /** Logger (mockable) — par défaut console */
  logger?: { error: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
};

export function createCreateUserEvent({
  prisma,
  generateUuid = randomUUID,
  logger = console,
}: CreateUserEventDeps) {
  return async function onCreateUser({ user }: { user: CreatedUser }): Promise<void> {
    if (!user.id) {
      logger.error('[auth-event:createUser] user.id missing — skipping supabaseUserId patch');
      return;
    }

    try {
      const existing = await prisma.user.findUnique({
        where: { id: user.id },
        select: { supabaseUserId: true },
      });

      if (existing?.supabaseUserId) {
        return;
      }

      const supabaseUserId = generateUuid();
      await prisma.user.update({
        where: { id: user.id },
        data: { supabaseUserId },
      });

      logger.info?.(
        JSON.stringify({
          tag: '[auth-event:createUser]',
          level: 'info',
          message: 'patched OAuth user with supabaseUserId',
          userId: user.id,
          email: user.email,
          ts: new Date().toISOString(),
        }),
      );
    } catch (err) {
      logger.error('[auth-event:createUser] failed to patch supabaseUserId', err);
    }
  };
}
