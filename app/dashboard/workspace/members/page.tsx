import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import { Users } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { InviteModal } from '@/components/workspace/InviteModal';
import { MembersTable } from '@/components/workspace/MembersTable';
import type { WorkspaceMember, WorkspaceRole } from '@/types/workspace';
import { canInviteMembers } from '@/types/workspace';

// TODO(P1.5): Quand Prisma hub est initialisé :
// - Remplacer getMockData() par des vraies requêtes Prisma
// - Récupérer le workspace lié au tenant de l'utilisateur
// - Récupérer les membres et le rôle de l'acteur

const PRISMA_READY = false;

// Données de démo — à supprimer quand Prisma est dispo
function getMockData(userId: string): {
  workspace: { id: string; name: string };
  members: WorkspaceMember[];
  actorRole: WorkspaceRole;
} {
  return {
    workspace: { id: 'ws_demo', name: 'Mon Workspace' },
    actorRole: 'OWNER',
    members: [
      {
        id: 'mem_1',
        workspaceId: 'ws_demo',
        userId,
        email: 'vous@example.com',
        name: 'Vous (démo)',
        role: 'OWNER',
        invitedAt: new Date().toISOString(),
        joinedAt: new Date().toISOString(),
      },
      {
        id: 'mem_2',
        workspaceId: 'ws_demo',
        userId: 'user_demo_2',
        email: 'admin@example.com',
        name: 'Admin Démo',
        role: 'ADMIN',
        invitedAt: new Date(Date.now() - 5 * 86400_000).toISOString(),
        joinedAt: new Date(Date.now() - 4 * 86400_000).toISOString(),
      },
      {
        id: 'mem_3',
        workspaceId: 'ws_demo',
        userId: 'user_demo_3',
        email: 'invite@example.com',
        role: 'MEMBER',
        invitedAt: new Date(Date.now() - 86400_000).toISOString(),
        joinedAt: null,
      },
    ],
  };
}

export default async function WorkspaceMembersPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  let workspace: { id: string; name: string };
  let members: WorkspaceMember[];
  let actorRole: WorkspaceRole;

  if (!PRISMA_READY) {
    // Mode démo jusqu'à l'activation de Prisma
    const mock = getMockData(user.id);
    workspace = mock.workspace;
    members = mock.members;
    actorRole = mock.actorRole;
  } else {
    // TODO: implémentation Prisma
    // const prisma = getPrismaClient();
    // const dbWorkspace = await prisma.workspace.findFirst({
    //   where: { members: { some: { userId: user.id } }, deletedAt: null },
    //   include: {
    //     members: {
    //       include: { user: { select: { email: true, name: true } } },
    //     },
    //   },
    // });
    // if (!dbWorkspace) redirect('/dashboard');
    // ...
    redirect('/dashboard');
  }

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
          <strong>{workspace.name}</strong>.
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
            <InviteModal workspaceId={workspace.id} />
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

      {!PRISMA_READY && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>Mode démo</strong> — La fonctionnalité membres est en cours de déploiement.
          Les données affichées sont fictives.
        </div>
      )}
    </div>
  );
}
