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

  return (
    <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
      <DashboardPageHeader
        title="Settings"
        description="Manage your account settings and workspaces"
        icon={Settings}
      />

      <div className="grid gap-6">
        {/* Profile Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>
              Update your personal information
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
            <CardTitle>Security</CardTitle>
            <CardDescription>
              Change your password
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

        {/* Tenant Information */}
        {tenant && (
          <Card>
            <CardHeader>
              <CardTitle>Workspaces</CardTitle>
              <CardDescription>
                Your active workspaces and integrations
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Notifuse */}
              {tenant.notifuseWorkspaceSlug && (
                <div className="rounded-lg border p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">Notifuse</h3>
                    <Badge variant="success" className="ml-auto">
                      Active
                    </Badge>
                  </div>
                  <div className="text-sm text-muted-foreground space-y-1">
                    <div><strong>Email:</strong> {tenant.notifuseUserEmail}</div>
                    <div>
                      <strong>Workspace:</strong>{' '}
                      <code className="text-xs bg-muted px-2 py-0.5 rounded">
                        {tenant.notifuseWorkspaceSlug}
                      </code>
                    </div>
                  </div>
                </div>
              )}

              {!tenant.notifuseWorkspaceSlug && (
                <div className="text-center py-6 text-muted-foreground">
                  <p>No workspaces configured yet</p>
                  <p className="text-sm mt-2">
                    Go to the{' '}
                    <a href="/dashboard" className="text-primary hover:underline">
                      dashboard
                    </a>{' '}
                    to create your first workspace
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Account Info */}
        <Card>
          <CardHeader>
            <CardTitle>Account Information</CardTitle>
            <CardDescription>
              View your account details
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Account ID</span>
              <code className="text-xs bg-muted px-2 py-0.5 rounded">{user.id.slice(0, 8)}...</code>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email Verified</span>
              <span className={dbUser?.emailVerified ? 'text-success' : 'text-warning'}>
                {dbUser?.emailVerified ? 'Verified' : 'Not verified'}
              </span>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Member Since</span>
              <span>
                {dbUser?.createdAt
                  ? new Date(dbUser.createdAt).toLocaleDateString()
                  : '—'}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Danger Zone */}
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Danger Zone</CardTitle>
            <CardDescription>
              Irreversible actions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              If you need to delete your account or workspaces, please contact support.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
