/**
 * Event `createUser` Auth.js v5 — patch le user fraîchement créé par le
 * PrismaAdapter avec :
 *   1. un `supabaseUserId` UUID v4 (régression 2026-05-21 OAuth sans pont
 *      vers `tenants.user_id` / `subscriptions.user_id`)
 *   2. un workspace par défaut + WorkspaceMember role=OWNER (régression
 *      2026-05-21 : 23 users prod sans workspace, page /members KO)
 *
 * CONTEXTE supabaseUserId : le flow signup Credentials
 * (`app/api/auth/signup/route.ts`) génère un `randomUUID()` et set
 * `supabaseUserId = userUuid` pour servir de pont vers `tenants.user_id` /
 * `subscriptions.user_id` (colonnes UUID).
 *
 * Le PrismaAdapter d'Auth.js, lui, ne sait rien de cette colonne et crée le
 * user OAuth avec `supabaseUserId = NULL`. Tout helper appelant `userUuid(user)`
 * throw alors → Dashboard Layout en panne, provisioning impossible.
 *
 * CONTEXTE workspace : aucun code ne créait de workspace au signup avant
 * 2026-05-21 → page `/dashboard/workspace/members` inaccessible pour 100 %
 * des users. Décision Robert (option 1 du ticket workspace-provisioning) :
 * auto-création silencieuse mono-workspace, pattern Linear/Notion/Slack.
 *
 * Ce module factorise la logique en pure function injectable pour la tester
 * unitairement sans monter une instance NextAuth.
 *
 * Contrat de retour Auth.js v5 events : Promise<void>. Les erreurs doivent
 * être loggées mais ne pas throw (sinon casse la session).
 *
 * Le bloc workspace est isolé dans son propre try/catch — un échec
 * provisioning workspace ne doit JAMAIS empêcher le patch supabaseUserId
 * (qui est plus critique : sans lui le Dashboard crashe).
 */

import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { provisionDefaultWorkspace } from '@/lib/workspace/provision';

type CreatedUser = {
  id?: string | null;
  email?: string | null;
  name?: string | null;
};

type ProvisionWorkspaceFn = typeof provisionDefaultWorkspace;

export type CreateUserEventDeps = {
  /** Prisma client minimal (mockable) */
  prisma: Pick<PrismaClient, 'user'> & PrismaClient;
  /** UUID factory injectable pour les tests déterministes */
  generateUuid?: () => string;
  /** Logger (mockable) — par défaut console */
  logger?: { error: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  /** Provision workspace function (mockable) — par défaut le module workspace */
  provisionWorkspace?: ProvisionWorkspaceFn;
};

export function createCreateUserEvent({
  prisma,
  generateUuid = randomUUID,
  logger = console,
  provisionWorkspace = provisionDefaultWorkspace,
}: CreateUserEventDeps) {
  return async function onCreateUser({ user }: { user: CreatedUser }): Promise<void> {
    if (!user.id) {
      logger.error('[auth-event:createUser] user.id missing — skipping supabaseUserId patch');
      return;
    }

    // ─── 1. Patch supabaseUserId (critique pour Dashboard) ──────────────
    try {
      const existing = await prisma.user.findUnique({
        where: { id: user.id },
        select: { supabaseUserId: true },
      });

      if (!existing?.supabaseUserId) {
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
      }
    } catch (err) {
      logger.error('[auth-event:createUser] failed to patch supabaseUserId', err);
    }

    // ─── 2. Provision workspace par défaut (best-effort) ────────────────
    // Isolé de l'étape 1 — un échec ici ne doit pas bloquer la session.
    // L'idempotence est gérée côté provisionDefaultWorkspace (skip si user
    // déjà membre d'un workspace actif).
    if (!user.email) {
      logger.error('[auth-event:createUser] user.email missing — skipping workspace provision');
      return;
    }

    try {
      const result = await provisionWorkspace(
        { userId: user.id, email: user.email, name: user.name ?? null },
        { prisma: prisma as PrismaClient, actor: 'system:oauth-signup', logger }
      );
      if (result.created) {
        logger.info?.(
          JSON.stringify({
            tag: '[auth-event:createUser]',
            level: 'info',
            message: 'provisioned default workspace for OAuth user',
            userId: user.id,
            workspaceId: result.workspaceId,
            ts: new Date().toISOString(),
          }),
        );
      }
    } catch (err) {
      logger.error('[auth-event:createUser] failed to provision default workspace', err);
    }
  };
}
