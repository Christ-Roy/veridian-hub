import { redirect } from 'next/navigation';
import NameForm from '@/components/ui/AccountForms/NameForm';
import EmailForm from '@/components/ui/AccountForms/EmailForm';
import PasswordForm from '@/components/ui/AccountForms/PasswordForm';
import ConnectedProvidersList from '@/components/account/ConnectedProvidersList';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { WorkspaceRenameForm } from "./WorkspaceRenameForm";
import { Settings } from 'lucide-react';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  // Fetch user complet pour name + createdAt + emailVerified
  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { createdAt: true, emailVerified: true, name: true },
  });

  // Récupérer le tenant principal
  const tenant = await prisma.tenant.findFirst({
    where: { userId: userUuid(user) },
    select: {
      id: true,
      notifuseWorkspaceSlug: true,
      notifuseUserEmail: true,
    },
  });

  // Workspace (Hub-internal) du user — soit owner direct, soit member.
  // On expose le rename form uniquement si user.id === workspace.ownerId.
  const workspace = await prisma.workspace.findFirst({
    where: {
      deletedAt: null,
      members: { some: { userId: user.id } },
    },
    select: { id: true, name: true, ownerId: true },
  });

  return (
    <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
      <DashboardPageHeader
        title="Paramètres"
        description="Gérez les paramètres de votre compte et vos workspaces"
        icon={Settings}
      />

      <div className="grid gap-6">
        {/* Profile Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Profil</CardTitle>
            <CardDescription>
              Mettez à jour vos informations personnelles
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <NameForm userName={dbUser?.name ?? user.name ?? ''} />
            <Separator />
            <EmailForm userEmail={user.email ?? ''} />
          </CardContent>
        </Card>

        {/* Security Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Sécurité</CardTitle>
            <CardDescription>
              Modifiez votre mot de passe
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PasswordForm />
          </CardContent>
        </Card>

        {/* Connected providers (OAuth + Credentials) */}
        <Card>
          <CardHeader>
            <CardTitle>Méthodes de connexion</CardTitle>
            <CardDescription>
              Gérez les providers OAuth et les identifiants associés à votre compte.
              Au moins une méthode de connexion doit rester active.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectedProvidersList />
          </CardContent>
        </Card>

        {/* Workspace rename */}
        {workspace && (
          <Card>
            <CardHeader>
              <CardTitle>Workspace</CardTitle>
              <CardDescription>
                Renommez votre espace de travail Veridian.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <WorkspaceRenameForm
                workspaceId={workspace.id}
                currentName={workspace.name}
                canRename={workspace.ownerId === user.id}
              />
            </CardContent>
          </Card>
        )}

        {/* Tenant Information */}
        {tenant && (
          <Card>
            <CardHeader>
              <CardTitle>Workspaces</CardTitle>
              <CardDescription>
                Vos workspaces et intégrations actifs
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Notifuse */}
              {tenant.notifuseWorkspaceSlug && (
                <div className="rounded-lg border p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">Notifuse</h3>
                    <Badge variant="success" className="ml-auto">
                      Actif
                    </Badge>
                  </div>
                  <div className="text-sm text-muted-foreground space-y-1">
                    <div><strong>Email :</strong> {tenant.notifuseUserEmail}</div>
                    <div>
                      <strong>Workspace :</strong>{' '}
                      <code className="text-xs bg-muted px-2 py-0.5 rounded">
                        {tenant.notifuseWorkspaceSlug}
                      </code>
                    </div>
                  </div>
                </div>
              )}

              {!tenant.notifuseWorkspaceSlug && (
                <div className="text-center py-6 text-muted-foreground">
                  <p>Aucun workspace configuré pour l&apos;instant</p>
                  <p className="text-sm mt-2">
                    Rendez-vous sur le{' '}
                    <a href="/dashboard" className="text-primary hover:underline">
                      tableau de bord
                    </a>{' '}
                    pour créer votre premier workspace
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Account Info */}
        <Card>
          <CardHeader>
            <CardTitle>Informations du compte</CardTitle>
            <CardDescription>
              Consultez les détails de votre compte
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Identifiant du compte</span>
              <code className="text-xs bg-muted px-2 py-0.5 rounded">{user.id.slice(0, 8)}...</code>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email vérifié</span>
              <span className={dbUser?.emailVerified ? 'text-success' : 'text-warning'}>
                {dbUser?.emailVerified ? 'Vérifié' : 'Non vérifié'}
              </span>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Membre depuis</span>
              <span>
                {dbUser?.createdAt
                  ? new Date(dbUser.createdAt).toLocaleDateString('fr-FR')
                  : '—'}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Danger Zone */}
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Zone de danger</CardTitle>
            <CardDescription>
              Actions irréversibles
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Pour supprimer votre compte ou vos workspaces, contactez le support.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
