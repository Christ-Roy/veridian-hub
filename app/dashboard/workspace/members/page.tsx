import { redirect } from 'next/navigation';
import { Users } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { InviteModal } from '@/components/workspace/InviteModal';
import { MembersTable } from '@/components/workspace/MembersTable';
import type { WorkspaceMember, WorkspaceRole } from '@/types/workspace';
import { canInviteMembers } from '@/types/workspace';
import { getCurrentUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { provisionDefaultWorkspace } from '@/lib/workspace/provision';

export default async function WorkspaceMembersPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  // Récupérer le premier workspace dont l'utilisateur est membre.
  // Mono-workspace au lancement (multi-workspace en P3+).
  let dbWorkspace = await prisma.workspace.findFirst({
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

  // Auto-self-heal : si l'user n'a aucun workspace (cas user prod legacy
  // pas encore backfillé OU bug de provisioning passé entre les mailles),
  // on provisionne ici à la volée. Idempotent côté provisionDefaultWorkspace.
  // À court terme : backfill script rattrape les 23 users prod. Ce fallback
  // reste comme filet anti-régression.
  if (!dbWorkspace) {
    try {
      await provisionDefaultWorkspace(
        { userId: user.id, email: user.email ?? '', name: user.name ?? null },
        { prisma, actor: 'system:members-page-self-heal' }
      );
      dbWorkspace = await prisma.workspace.findFirst({
        where: {
          members: { some: { userId: user.id } },
          deletedAt: null,
        },
        include: { members: { orderBy: { invitedAt: 'asc' } } },
      });
    } catch (err) {
      console.error('[WorkspaceMembersPage] self-heal failed:', err);
    }
  }

  if (!dbWorkspace) {
    // Cas extrême : self-heal a échoué (DB down ?). On rend une page sobre
    // au lieu d'un redirect silencieux. Les logs côté serveur tracent l'erreur.
    return (
      <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
        <DashboardPageHeader
          title="Membres"
          description="Impossible de charger votre workspace pour le moment."
          icon={Users}
        />
        <Card>
          <CardHeader>
            <CardTitle>Erreur temporaire</CardTitle>
            <CardDescription>
              Rechargez la page dans quelques secondes. Si le problème persiste,
              contactez le support.
            </CardDescription>
          </CardHeader>
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
      <DashboardPageHeader
        title="Membres"
        description={
          <>
            Gérez les membres et les accès de votre workspace{' '}
            <strong>{dbWorkspace.name}</strong>.
          </>
        }
        icon={Users}
      />

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
