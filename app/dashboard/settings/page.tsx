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
    <div className="flex flex-col gap-8 p-6 md:p-10 max-w-3xl mx-auto w-full">
      <DashboardPageHeader
        title="Paramètres"
        description="Gérez votre compte et vos préférences"
        icon={Settings}
      />

      <div className="flex flex-col gap-5">
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

        {/* Nom de l'espace */}
        {workspace && (
          <Card>
            <CardHeader>
              <CardTitle>Votre espace</CardTitle>
              <CardDescription>
                Choisissez le nom de votre espace Veridian.
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

        {/* Services actifs */}
        {tenant && (
          <Card>
            <CardHeader>
              <CardTitle>Vos services</CardTitle>
              <CardDescription>
                Les applications Veridian activées sur votre compte
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {tenant.notifuseWorkspaceSlug && (
                <div className="rounded-lg border p-4">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">Veridian Mail</h3>
                    <Badge variant="success" className="ml-auto">
                      Actif
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Vos emails et campagnes, prêts à l&apos;emploi.
                  </p>
                </div>
              )}

              {!tenant.notifuseWorkspaceSlug && (
                <div className="text-center py-6 text-muted-foreground">
                  <p>Aucun service activé pour l&apos;instant</p>
                  <p className="text-sm mt-2">
                    Rendez-vous sur votre{' '}
                    <a href="/dashboard" className="text-primary hover:underline">
                      tableau de bord
                    </a>{' '}
                    pour activer votre premier service.
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
              Pour supprimer votre compte, contactez notre support.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
