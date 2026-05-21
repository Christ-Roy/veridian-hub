import { redirect } from 'next/navigation';
import { Users, Building2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { InviteModal } from '@/components/workspace/InviteModal';
import { MembersTable } from '@/components/workspace/MembersTable';
import type { WorkspaceMember, WorkspaceRole } from '@/types/workspace';
import { canInviteMembers } from '@/types/workspace';
import { getCurrentUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

export default async function WorkspaceMembersPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  // Récupérer le premier workspace dont l'utilisateur est membre.
  // Mono-workspace au lancement (multi-workspace en P3+).
  const dbWorkspace = await prisma.workspace.findFirst({
    where: {
      members: { some: { userId: user.id } },
      deletedAt: null,
    },
    include: {
      members: {
        orderBy: { invitedAt: 'asc' },
      },
    },
  });

  if (!dbWorkspace) {
    // Aucun workspace pour ce user. Le provisioning auto au signup n'est
    // pas encore câblé (cf. todo/2026-05-21-workspace-provisioning-at-signup.md).
    // En attendant, on affiche un placeholder lisible plutôt que de
    // rediriger silencieusement vers /dashboard (mauvaise UX).
    return (
      <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Users className="h-10 w-10 text-primary" />
            <h1 className="text-4xl font-bold tracking-tight">Membres</h1>
          </div>
          <p className="text-muted-foreground">
            Invitez et gérez les membres de votre workspace.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Building2 className="h-6 w-6 text-muted-foreground" />
              <div>
                <CardTitle>Pas encore de workspace</CardTitle>
                <CardDescription>
                  Pour inviter des membres, vous devez d&apos;abord créer un workspace.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-start gap-2 rounded-md bg-muted/50 p-4 text-sm">
              <Sparkles className="h-4 w-4 mt-0.5 text-primary shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">Fonctionnalité en cours de finalisation</p>
                <p className="text-muted-foreground">
                  La création de workspace sera disponible très prochainement. En attendant,
                  vous pouvez continuer à utiliser Veridian depuis votre{' '}
                  <a href="/dashboard" className="underline underline-offset-4">tableau de bord</a>.
                </p>
              </div>
            </div>

            <Button disabled className="w-full sm:w-auto">
              Créer mon workspace
              <span className="ml-2 text-xs opacity-60">(bientôt)</span>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Le user lui-même est-il membre ? (on s'attend à oui d'après la query)
  const actorMember = dbWorkspace.members.find((m) => m.userId === user.id);
  const actorRole: WorkspaceRole = (actorMember?.role as WorkspaceRole) || 'MEMBER';

  // Hydrater les membres avec leurs emails / noms (jointure manuelle pour
  // éviter d'imposer une relation Prisma forte côté User.workspaceMembers
  // qui n'existe pas encore — cf prisma/schema.prisma).
  const memberUserIds = dbWorkspace.members.map((m) => m.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: memberUserIds } },
    select: { id: true, email: true, name: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  const members: WorkspaceMember[] = dbWorkspace.members.map((m) => {
    const u = userMap.get(m.userId);
    return {
      id: m.id,
      workspaceId: m.workspaceId,
      userId: m.userId,
      email: u?.email ?? '',
      name: u?.name ?? null,
      role: m.role as WorkspaceRole,
      invitedAt: m.invitedAt.toISOString(),
      joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
    };
  });

  const userCanInvite = canInviteMembers(actorRole);

  return (
    <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <Users className="h-10 w-10 text-primary" />
          <h1 className="text-4xl font-bold tracking-tight">Membres</h1>
        </div>
        <p className="text-muted-foreground">
          Gérez les membres et les accès de votre workspace{' '}
          <strong>{dbWorkspace.name}</strong>.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Membres du workspace</CardTitle>
            <CardDescription>
              {members.length} membre{members.length > 1 ? 's' : ''}
            </CardDescription>
          </div>
          {userCanInvite && (
            <InviteModal workspaceId={dbWorkspace.id} />
          )}
        </CardHeader>
        <CardContent>
          <MembersTable
            members={members}
            actorRole={actorRole}
            actorUserId={user.id}
          />
        </CardContent>
      </Card>
    </div>
  );
}
