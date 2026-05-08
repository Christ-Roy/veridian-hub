import { NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes } from 'crypto';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { sendMail } from '@/lib/email/send';
import { buildInvitationEmail } from '@/lib/email/templates/invitation';
import { canInviteMembers, WORKSPACE_ROLE_LABELS } from '@/types/workspace';
import type { WorkspaceRole } from '@/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const InviteSchema = z.object({
  workspaceId: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']),
});

export async function POST(request: Request) {
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

  const parsed = InviteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Données invalides', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { workspaceId, email, role } = parsed.data;

  // 1. Vérifier que l'acteur est OWNER ou ADMIN du workspace
  const actor = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: sessionUser.id } },
  });
  if (!actor || !canInviteMembers(actor.role as WorkspaceRole)) {
    return NextResponse.json({ error: 'Droits insuffisants' }, { status: 403 });
  }

  // 2. Vérifier que l'email n'est pas déjà membre.
  // WorkspaceMember n'a pas de relation user dans le schema — on passe par
  // User.findUnique({email}) puis WorkspaceMember.findUnique.
  const userByEmail = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (userByEmail) {
    const alreadyMember = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: userByEmail.id } },
    });
    if (alreadyMember) {
      return NextResponse.json(
        { error: 'Cet email est déjà membre du workspace' },
        { status: 409 },
      );
    }
  }

  // 3. Créer ou renouveler l'invitation
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) {
    return NextResponse.json({ error: 'Workspace introuvable' }, { status: 404 });
  }

  const inviterName = sessionUser.email ?? sessionUser.name ?? 'Un administrateur';

  const invitation = await prisma.invitation.create({
    data: {
      workspaceId,
      email,
      role,
      token,
      expiresAt,
    },
  });

  // 4. Envoyer l'email Brevo
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://app.veridian.site';
  try {
    await sendMail({
      to: email,
      subject: `Invitation à rejoindre ${workspace.name}`,
      html: buildInvitationEmail({
        inviterName,
        workspaceName: workspace.name,
        role: WORKSPACE_ROLE_LABELS[role as WorkspaceRole],
        inviteUrl: `${baseUrl}/invite/${token}`,
        expiresAt,
      }),
    });
  } catch (err) {
    console.error('[invite] email send failed', err);
    // On garde l'invitation en DB — l'admin peut renvoyer le lien manuellement
  }

  return NextResponse.json({ ok: true, invitationId: invitation.id });
}
