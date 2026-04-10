import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { z } from 'zod';
import { canInviteMembers } from '@/types/workspace';
import type { WorkspaceRole } from '@/types/workspace';
import { WORKSPACE_ROLE_LABELS } from '@/types/workspace';

// TODO(P1.5): Remplacer le stub par la vraie implémentation Prisma
// dès que hub-auth-builder a commité le schema Prisma hub_app.
// Ce endpoint retourne 503 jusqu'à ce que Prisma soit initialisé.

const PRISMA_READY = false; // à basculer à true quand Prisma hub est dispo

const InviteSchema = z.object({
  workspaceId: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']),
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

  const parsed = InviteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Données invalides', details: parsed.error.flatten() }, { status: 422 });
  }

  if (!PRISMA_READY) {
    // Stub — Prisma hub pas encore initialisé
    return NextResponse.json(
      { error: 'Service temporairement indisponible — Prisma hub en cours d\'initialisation (P1.4)' },
      { status: 503 }
    );
  }

  // ==== IMPLÉMENTATION COMPLÈTE (activer quand Prisma dispo) ====
  // const { workspaceId, email, role } = parsed.data;
  //
  // 1. Vérifier que l'acteur est OWNER ou ADMIN du workspace
  // const actor = await prisma.workspaceMember.findUnique({
  //   where: { workspaceId_userId: { workspaceId, userId: user.id } },
  // });
  // if (!actor || !canInviteMembers(actor.role as WorkspaceRole)) {
  //   return NextResponse.json({ error: 'Droits insuffisants' }, { status: 403 });
  // }
  //
  // 2. Vérifier que l'email n'est pas déjà membre
  // const existing = await prisma.workspaceMember.findFirst({
  //   where: { workspaceId, user: { email } },
  // });
  // if (existing) {
  //   return NextResponse.json({ error: 'Cet email est déjà membre du workspace' }, { status: 409 });
  // }
  //
  // 3. Créer ou renouveler l'invitation
  // const { randomBytes } = await import('crypto');
  // const token = randomBytes(32).toString('hex');
  // const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  //
  // const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  // const inviterName = user.email ?? 'Un administrateur';
  //
  // await prisma.invitation.upsert({
  //   where: { token },
  //   create: { workspaceId, email, role, token, expiresAt },
  //   update: { role, token, expiresAt, acceptedAt: null },
  // });
  //
  // 4. Envoyer l'email Brevo
  // const { sendMail } = await import('@/lib/email/send');
  // const { buildInvitationEmail } = await import('@/lib/email/templates/invitation');
  // const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://app.veridian.site';
  // await sendMail({
  //   to: email,
  //   subject: `Invitation à rejoindre ${workspace?.name ?? 'Veridian'}`,
  //   html: buildInvitationEmail({
  //     inviterName,
  //     workspaceName: workspace?.name ?? 'Veridian',
  //     role: WORKSPACE_ROLE_LABELS[role as WorkspaceRole],
  //     inviteUrl: `${baseUrl}/invite/${token}`,
  //     expiresAt,
  //   }),
  // });
  //
  // return NextResponse.json({ ok: true, invitationId: invitation.id });
  // ==============================================================

  return NextResponse.json({ ok: true });
}
