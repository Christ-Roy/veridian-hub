/**
 * PATCH /api/workspace/[id]/rename
 *
 * Renomme un workspace. Auth session + check owner (`Workspace.ownerId === user.id`).
 *
 * Body : `{ name: string trim 1..80 }`
 * Response 200 : `{ id, name }`
 * Response 4xx :
 *  - 400 : body invalide
 *  - 401 : pas authentifié
 *  - 403 : user n'est pas owner du workspace
 *  - 404 : workspace introuvable ou soft-deleted
 *
 * Émet un audit log (`workspace.rename`) avec actor + previous/new name
 * pour la traçabilité. Best-effort — n'échoue pas la requête si l'audit
 * fail (cf lib/admin/audit-log.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { writeAuditLog } from '@/lib/admin/audit-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  name: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1, { message: 'name required' }).max(80, { message: 'name too long' })),
});

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }

  const { id: workspaceId } = await ctx.params;
  if (!workspaceId) {
    return NextResponse.json({ error: 'missing_workspace_id' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_payload', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const newName = parsed.data.name;

  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true, name: true, ownerId: true },
  });

  if (!workspace) {
    return NextResponse.json({ error: 'workspace_not_found' }, { status: 404 });
  }

  if (workspace.ownerId !== user.id) {
    return NextResponse.json({ error: 'forbidden_not_owner' }, { status: 403 });
  }

  // No-op si même nom (renvoie 200 quand même, idempotent)
  if (workspace.name === newName) {
    return NextResponse.json({ id: workspace.id, name: workspace.name });
  }

  const updated = await prisma.workspace.update({
    where: { id: workspace.id },
    data: { name: newName },
    select: { id: true, name: true },
  });

  // Audit log best-effort — ne pas faire échouer la requête sur audit fail
  await writeAuditLog(prisma, {
    action: 'workspace.rename',
    actor: `user:${user.id}`,
    targetType: 'tenant',
    targetId: workspace.id,
    payload: { previous_name: workspace.name, new_name: newName },
  });

  return NextResponse.json(updated);
}
