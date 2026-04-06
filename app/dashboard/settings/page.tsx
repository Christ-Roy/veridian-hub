import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import NameForm from '@/components/ui/AccountForms/NameForm';
import EmailForm from '@/components/ui/AccountForms/EmailForm';
import PasswordForm from '@/components/ui/AccountForms/PasswordForm';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Settings } from 'lucide-react';

export default async function SettingsPage() {
  const supabase = createClient();

  // 🔒 Auth check
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Récupérer les détails du profil
  const { data: userDetails } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  // Récupérer le tenant
  const { data: tenant } = await supabase
    .from('tenants')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle() as { data: any };

  return (
    <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <Settings className="h-10 w-10 text-primary" />
          <h1 className="text-4xl font-bold tracking-tight">Settings</h1>
        </div>
        <p className="text-muted-foreground">
          Manage your account settings and workspaces
        </p>
      </div>

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
            {/* 🔒 COMPOSANTS BACKEND - Logique conservée */}
            <NameForm userName={(userDetails as any)?.full_name ?? ''} />
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
              {/* Twenty CRM */}
              {tenant.twenty_workspace_id && (
                <div className="rounded-lg border p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">📇</span>
                    <h3 className="font-semibold">Twenty CRM</h3>
                    <span className="ml-auto text-xs bg-green-100 text-green-800 px-2 py-1 rounded-full dark:bg-green-900/30 dark:text-green-400">
                      Active
                    </span>
                  </div>
                  <div className="text-sm text-muted-foreground space-y-1">
                    <div><strong>Email:</strong> {tenant.twenty_user_email}</div>
                    <div>
                      <strong>Workspace ID:</strong>{' '}
                      <code className="text-xs bg-muted px-2 py-0.5 rounded">
                        {tenant.twenty_workspace_id}
                      </code>
                    </div>
                  </div>
                </div>
              )}

              {/* Notifuse */}
              {tenant.notifuse_workspace_slug && (
                <div className="rounded-lg border p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">📧</span>
                    <h3 className="font-semibold">Notifuse</h3>
                    <span className="ml-auto text-xs bg-green-100 text-green-800 px-2 py-1 rounded-full dark:bg-green-900/30 dark:text-green-400">
                      Active
                    </span>
                  </div>
                  <div className="text-sm text-muted-foreground space-y-1">
                    <div><strong>Email:</strong> {tenant.notifuse_user_email}</div>
                    <div>
                      <strong>Workspace:</strong>{' '}
                      <code className="text-xs bg-muted px-2 py-0.5 rounded">
                        {tenant.notifuse_workspace_slug}
                      </code>
                    </div>
                  </div>
                </div>
              )}

              {!tenant.twenty_workspace_id && !tenant.notifuse_workspace_slug && (
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
              <span className={user.email_confirmed_at ? 'text-green-600' : 'text-amber-600'}>
                {user.email_confirmed_at ? '✓ Verified' : '⚠ Not verified'}
              </span>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Member Since</span>
              <span>{new Date(user.created_at).toLocaleDateString()}</span>
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
