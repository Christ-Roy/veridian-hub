/**
 * Provisioning workspace par défaut au signup.
 *
 * CONTEXTE : avant 2026-05-21, aucun code ne créait de workspace au signup —
 * seul `/api/workspace/invite/accept` créait des `workspaceMembers`. Résultat :
 * 100 % des 23 users prod (signup hors flow invitation) n'avaient AUCUN
 * workspace, ce qui rendait `/dashboard/workspace/members` inaccessible
 * (silent redirect → /dashboard avant placeholder f88b8c0).
 *
 * Décision Robert 2026-05-21 (option 1 du ticket) : auto-création silencieuse
 * mono-workspace au signup, pattern Linear/Notion/Slack. Pas de flow
 * onboarding, pas de bouton manuel.
 *
 * Ce module est appelé depuis :
 *  - `auth.ts` event `createUser` (signups OAuth Google + Microsoft)
 *  - `app/api/auth/signup/route.ts` (signup Credentials)
 *  - `scripts/admin/backfill-workspaces.ts` (backfill 23 users existants)
 *
 * INVARIANTS :
 *  - **Idempotent** : si l'user est déjà membre d'un workspace (deletedAt
 *    null), on ne crée rien et on renvoie le workspace existant.
 *  - **Best-effort côté Auth.js event** : un échec ne doit JAMAIS faire
 *    échouer le signup. L'event swallow ses erreurs ; ce module les laisse
 *    remonter pour que le caller décide.
 *  - **Transaction** : la création workspace + member est atomique.
 *  - **Audit log** : append-only dans `audit_log` pour traçabilité (pas
 *    bloquant en cas d'échec).
 *
 * Le schema Prisma n'a PAS de colonne `slug` sur Workspace, donc on ne
 * gère qu'un nom. Pas de risque de collision unique.
 */

import type { PrismaClient } from '@prisma/client';
import { writeAuditLog } from '@/lib/admin/audit-log';

export type ProvisionWorkspaceInput = {
  userId: string;
  email: string;
  name?: string | null;
};

export type ProvisionWorkspaceResult = {
  workspaceId: string;
  created: boolean; // true si workspace fraîchement créé, false si déjà membre
  workspaceName: string;
};

export type ProvisionWorkspaceDeps = {
  prisma: PrismaClient;
  /** Actor pour l'audit log. Default 'system:signup'. */
  actor?: string;
  /** Logger (mockable) — par défaut console */
  logger?: { error: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
};

/**
 * Génère le nom par défaut du workspace au signup.
 * Pattern : `${name || email-local-part} workspace`.
 *
 * Exposé pour permettre aux tests de vérifier la convention.
 */
export function defaultWorkspaceName(input: { name?: string | null; email: string }): string {
  const trimmed = (input.name ?? '').trim();
  if (trimmed.length > 0) {
    return `${trimmed} workspace`;
  }
  const localPart = input.email.split('@')[0] ?? 'user';
  return `${localPart} workspace`;
}

/**
 * Crée le workspace par défaut + WorkspaceMember role=OWNER pour le user.
 *
 * Idempotent : si l'user est déjà membre d'un workspace non supprimé,
 * renvoie cet existant sans créer de doublon. La détection se fait via
 * `workspaceMember` (pas `ownedBy`) pour couvrir les users invités qui
 * sont déjà membres ailleurs — on ne veut pas leur créer un workspace
 * personnel parasite.
 */
export async function provisionDefaultWorkspace(
  input: ProvisionWorkspaceInput,
  deps: ProvisionWorkspaceDeps
): Promise<ProvisionWorkspaceResult> {
  const { prisma, actor = 'system:signup', logger = console } = deps;

  // ─── 1. Idempotence : déjà membre d'un workspace actif ? ──────────────
  const existingMembership = await prisma.workspaceMember.findFirst({
    where: {
      userId: input.userId,
      workspace: { deletedAt: null },
    },
    include: { workspace: { select: { id: true, name: true } } },
  });

  if (existingMembership) {
    return {
      workspaceId: existingMembership.workspace.id,
      created: false,
      workspaceName: existingMembership.workspace.name,
    };
  }

  // ─── 2. Création atomique workspace + member OWNER ────────────────────
  const workspaceName = defaultWorkspaceName(input);

  const workspace = await prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.create({
      data: {
        name: workspaceName,
        ownerId: input.userId,
      },
      select: { id: true, name: true },
    });
    await tx.workspaceMember.create({
      data: {
        workspaceId: ws.id,
        userId: input.userId,
        role: 'OWNER',
        joinedAt: new Date(),
      },
    });
    return ws;
  });

  logger.info?.(
    JSON.stringify({
      tag: '[workspace-provision]',
      level: 'info',
      message: 'created default workspace for user',
      userId: input.userId,
      email: input.email,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      ts: new Date().toISOString(),
    })
  );

  // ─── 3. Audit log (best-effort) ───────────────────────────────────────
  await writeAuditLog(prisma, {
    action: 'workspace.provision.signup',
    actor,
    targetType: 'user',
    targetId: input.userId,
    payload: {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      email: input.email,
    },
  });

  return {
    workspaceId: workspace.id,
    created: true,
    workspaceName: workspace.name,
  };
}
