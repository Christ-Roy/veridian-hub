/**
 * Backfill workspace par défaut pour tous les users qui n'en ont pas.
 *
 * Contexte (ticket todo/2026-05-21-workspace-provisioning-at-signup.md) :
 *   La page /dashboard/workspace/members redirigeait silencieusement vers
 *   /dashboard pour 100% des users prod (23/23) car aucun n'avait de
 *   workspace. Le seul code qui crée un WorkspaceMember est
 *   /api/workspace/invite/accept — bootstrap workspace inexistant au signup.
 *
 *   Cette migration data crée pour chaque user orphelin :
 *     - 1 row workspaces  (name = "Personnel — <baseName>", owner_id = user.id)
 *     - 1 row workspace_members (role = OWNER, joined_at = NOW())
 *
 *   Le nom est "<full_name OU local-part-email>" pour rester lisible côté UI.
 *
 * Mode :
 *   - Idempotent : skip si le user a déjà un workspace_member quel qu'il soit
 *   - Transactionnel par user (1 user = 1 transaction Prisma)
 *   - Audit log dans hub_app.audit_log pour traçabilité (action = "workspace.backfill")
 *
 * Usage :
 *   DRY_RUN=true  pnpm tsx scripts/admin/backfill-workspaces.ts   # preview only
 *   DRY_RUN=false pnpm tsx scripts/admin/backfill-workspaces.ts   # apply
 *
 * Variables d'environnement attendues :
 *   - DATABASE_URL : Postgres URL vers veridian-core-db (schéma hub_app)
 *   - DRY_RUN      : 'true' par défaut sécurité (oblige opt-in explicite à 'false')
 */

import { PrismaClient } from '@prisma/client';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';

async function main() {
  const prisma = new PrismaClient();

  console.log(`[backfill-workspaces] DRY_RUN=${DRY_RUN}`);

  const orphans = await prisma.user.findMany({
    where: {
      // Pas de WorkspaceMember référençant cet user (relation indirecte via id)
      // Prisma ne supporte pas le NOT IN avec subquery direct ici → on filtre côté JS
    },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Récupérer les user_ids déjà présents dans workspace_members
  const existingMembers = await prisma.workspaceMember.findMany({
    select: { userId: true },
  });
  const memberUserIds = new Set(existingMembers.map((m) => m.userId));
  const trueOrphans = orphans.filter((u) => !memberUserIds.has(u.id));

  console.log(`[backfill-workspaces] users total: ${orphans.length}`);
  console.log(`[backfill-workspaces] users avec workspace: ${memberUserIds.size}`);
  console.log(`[backfill-workspaces] users orphelins à traiter: ${trueOrphans.length}`);

  let created = 0;
  let skipped = 0;
  const errors: Array<{ userId: string; email: string; error: string }> = [];

  for (const user of trueOrphans) {
    const baseName = user.name?.trim() || user.email.split('@')[0];
    const workspaceName = `Personnel — ${baseName}`;

    if (DRY_RUN) {
      console.log(
        `[dry-run] CREATE workspace "${workspaceName}" + OWNER membership for user ${user.id} (${user.email})`,
      );
      created++;
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Sécurité : re-check au cas où une race condition a rempli entretemps
        const existing = await tx.workspaceMember.findFirst({
          where: { userId: user.id },
          select: { id: true },
        });
        if (existing) {
          skipped++;
          return;
        }

        const workspace = await tx.workspace.create({
          data: {
            name: workspaceName,
            ownerId: user.id,
            members: {
              create: {
                userId: user.id,
                role: 'OWNER',
                joinedAt: new Date(),
              },
            },
          },
          select: { id: true, name: true },
        });

        await tx.auditLog.create({
          data: {
            action: 'workspace.backfill',
            actor: 'system:backfill-workspaces',
            targetType: 'workspace',
            targetId: workspace.id,
            payload: {
              userId: user.id,
              userEmail: user.email,
              workspaceName: workspace.name,
            },
          },
        });

        created++;
        console.log(`[ok] user=${user.id} workspace=${workspace.id} "${workspace.name}"`);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ userId: user.id, email: user.email, error: msg });
      console.error(`[err] user=${user.id} email=${user.email}: ${msg}`);
    }
  }

  console.log('---');
  console.log(`[backfill-workspaces] créés: ${created}`);
  console.log(`[backfill-workspaces] skipped (race): ${skipped}`);
  console.log(`[backfill-workspaces] erreurs: ${errors.length}`);
  if (errors.length > 0) {
    console.log('[errors]', JSON.stringify(errors, null, 2));
  }

  await prisma.$disconnect();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(2);
});
