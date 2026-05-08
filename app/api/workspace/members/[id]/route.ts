import { NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { canChangeRole, canRemoveMember } from '@/types/workspace';
import type { WorkspaceRole } from '@/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const sessionUser = session?.user;
  if (!sessionUser?.id) {
    return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corps de requête invalide' }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Rôle invalide' }, { status: 422 });
  }

  const { id } = await params;
  const { role } = parsed.data;

  const target = await prisma.workspaceMember.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: 'Membre introuvable' }, { status: 404 });
  }

  const actor = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: target.workspaceId,
        userId: sessionUser.id,
      },
    },
  });
  if (
    !actor ||
    !canChangeRole(actor.role as WorkspaceRole, target.role as WorkspaceRole)
  ) {
    return NextResponse.json({ error: 'Droits insuffisants' }, { status: 403 });
  }

  await prisma.workspaceMember.update({ where: { id }, data: { role } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const sessionUser = session?.user;
  if (!sessionUser?.id) {
    return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
  }

  const { id } = await params;

  const target = await prisma.workspaceMember.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: 'Membre introuvable' }, { status: 404 });
  }
  if (target.role === 'OWNER') {
    return NextResponse.json(
      { error: 'Impossible de retirer le propriétaire' },
      { status: 403 },
    );
  }

  const actor = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: target.workspaceId,
        userId: sessionUser.id,
      },
    },
  });
  if (
    !actor ||
    !canRemoveMember(actor.role as WorkspaceRole, target.role as WorkspaceRole)
  ) {
    return NextResponse.json({ error: 'Droits insuffisants' }, { status: 403 });
  }

  await prisma.workspaceMember.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
