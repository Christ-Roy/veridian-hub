import { NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AcceptSchema = z.object({
  token: z.string().min(1),
});

export async function POST(request: Request) {
  const session = await auth();
  const sessionUser = session?.user;

  if (!sessionUser?.id || !sessionUser.email) {
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

  const { token } = parsed.data;

  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { workspace: true },
  });

  if (!invitation) {
    return NextResponse.json({ error: 'Invitation introuvable' }, { status: 404 });
  }
  if (invitation.acceptedAt) {
    return NextResponse.json({ error: 'Invitation déjà utilisée' }, { status: 409 });
  }
  if (invitation.expiresAt < new Date()) {
    return NextResponse.json({ error: 'Invitation expirée' }, { status: 410 });
  }
  if (invitation.email.toLowerCase() !== sessionUser.email.toLowerCase()) {
    return NextResponse.json(
      { error: 'Email ne correspond pas' },
      { status: 403 },
    );
  }

  // Vérifier si déjà membre
  const existingMember = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: invitation.workspaceId,
        userId: sessionUser.id,
      },
    },
  });
  if (existingMember) {
    return NextResponse.json(
      { error: 'Déjà membre du workspace' },
      { status: 409 },
    );
  }

  await prisma.$transaction([
    prisma.workspaceMember.create({
      data: {
        workspaceId: invitation.workspaceId,
        userId: sessionUser.id,
        role: invitation.role,
        joinedAt: new Date(),
      },
    }),
    prisma.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
