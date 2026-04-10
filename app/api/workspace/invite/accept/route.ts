import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { z } from 'zod';

// TODO(P1.5): Stub — activer quand Prisma hub_app est initialisé

const PRISMA_READY = false;

const AcceptSchema = z.object({
  token: z.string().min(1),
});

export async function POST(request: Request) {
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

  const parsed = AcceptSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Token manquant' }, { status: 422 });
  }

  if (!PRISMA_READY) {
    return NextResponse.json(
      { error: 'Service temporairement indisponible — Prisma hub en cours d\'initialisation (P1.4)' },
      { status: 503 }
    );
  }

  // ==== IMPLÉMENTATION PRISMA ====
  // const { token } = parsed.data;
  //
  // const invitation = await prisma.invitation.findUnique({
  //   where: { token },
  //   include: { workspace: true },
  // });
  //
  // if (!invitation) return NextResponse.json({ error: 'Invitation introuvable' }, { status: 404 });
  // if (invitation.acceptedAt) return NextResponse.json({ error: 'Invitation déjà utilisée' }, { status: 409 });
  // if (invitation.expiresAt < new Date()) return NextResponse.json({ error: 'Invitation expirée' }, { status: 410 });
  // if (invitation.email !== user.email) return NextResponse.json({ error: 'Email ne correspond pas' }, { status: 403 });
  //
  // // Vérifier si déjà membre
  // const existing = await prisma.workspaceMember.findUnique({
  //   where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id } },
  // });
  // if (existing) return NextResponse.json({ error: 'Déjà membre du workspace' }, { status: 409 });
  //
  // await prisma.$transaction([
  //   prisma.workspaceMember.create({
  //     data: {
  //       workspaceId: invitation.workspaceId,
  //       userId: user.id,
  //       role: invitation.role,
  //       joinedAt: new Date(),
  //     },
  //   }),
  //   prisma.invitation.update({
  //     where: { id: invitation.id },
  //     data: { acceptedAt: new Date() },
  //   }),
  // ]);
  //
  // return NextResponse.json({ ok: true });
  // ================================

  return NextResponse.json({ ok: true });
}
