import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { z } from 'zod';

// TODO(P1.5): Stub — activer l'implémentation Prisma dès que hub-auth-builder
// a commité le schema Prisma hub_app.

const PRISMA_READY = false;

const PatchSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']),
});

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
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

  if (!PRISMA_READY) {
    return NextResponse.json(
      { error: 'Service temporairement indisponible — Prisma hub en cours d\'initialisation (P1.4)' },
      { status: 503 }
    );
  }

  // ==== IMPLÉMENTATION COMPLÈTE ====
  // const { id } = params;
  // const { role } = parsed.data;
  //
  // const target = await prisma.workspaceMember.findUnique({ where: { id } });
  // if (!target) return NextResponse.json({ error: 'Membre introuvable' }, { status: 404 });
  //
  // const actor = await prisma.workspaceMember.findUnique({
  //   where: { workspaceId_userId: { workspaceId: target.workspaceId, userId: user.id } },
  // });
  // if (!actor || !canChangeRole(actor.role as WorkspaceRole, target.role as WorkspaceRole)) {
  //   return NextResponse.json({ error: 'Droits insuffisants' }, { status: 403 });
  // }
  //
  // await prisma.workspaceMember.update({ where: { id }, data: { role } });
  // return NextResponse.json({ ok: true });
  // =================================

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
  }

  if (!PRISMA_READY) {
    return NextResponse.json(
      { error: 'Service temporairement indisponible — Prisma hub en cours d\'initialisation (P1.4)' },
      { status: 503 }
    );
  }

  // ==== IMPLÉMENTATION COMPLÈTE ====
  // const { id } = params;
  //
  // const target = await prisma.workspaceMember.findUnique({ where: { id } });
  // if (!target) return NextResponse.json({ error: 'Membre introuvable' }, { status: 404 });
  // if (target.role === 'OWNER') return NextResponse.json({ error: 'Impossible de retirer le propriétaire' }, { status: 403 });
  //
  // const actor = await prisma.workspaceMember.findUnique({
  //   where: { workspaceId_userId: { workspaceId: target.workspaceId, userId: user.id } },
  // });
  // if (!actor || !canRemoveMember(actor.role as WorkspaceRole, target.role as WorkspaceRole)) {
  //   return NextResponse.json({ error: 'Droits insuffisants' }, { status: 403 });
  // }
  //
  // await prisma.workspaceMember.delete({ where: { id } });
  // return new NextResponse(null, { status: 204 });
  // =================================

  return new NextResponse(null, { status: 204 });
}
