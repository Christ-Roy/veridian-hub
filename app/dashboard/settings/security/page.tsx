// /dashboard/settings/security — toggle 2FA email opt-in.
// Server component : fetch l'état mfaEnabled du user courant via Prisma,
// délègue à un client component pour l'interaction.

import { redirect } from 'next/navigation';

import { ShieldCheck } from 'lucide-react';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { SecurityMfaToggle } from './SecurityMfaToggle';
import { SignOutEverywhere } from './SignOutEverywhere';
import Link from 'next/link';

export default async function SecuritySettingsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, mfaEnabled: true, supabaseUserId: true },
  });

  if (!user) {
    redirect('/login');
  }

  const motDePasse = await prisma.account.findFirst({
    where: { userId: user.id, provider: 'credentials', access_token: { not: null } },
    select: { id: true },
  });

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <DashboardPageHeader
        title="Sécurité"
        description="Renforcez la protection de votre compte Veridian."
        icon={ShieldCheck}
      />

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-medium">Validation par email</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Quand vous vous connectez avec votre mot de passe, Veridian vous envoie un code
            à 6 chiffres par email. Votre session reste active pendant un an pour éviter
            les reconnexions fréquentes.
          </p>
        </div>

        <SecurityMfaToggle initialEnabled={user.mfaEnabled} email={user.email} hasPassword={Boolean(motDePasse)} />
      </Card>

      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-medium">Sessions</h2>
        <SignOutEverywhere />
      </Card>

      <Card className="p-6 space-y-2">
        <h2 className="text-lg font-medium">Assistants IA</h2>
        <p className="text-sm text-muted-foreground">
          Les assistants reliés à votre compte se gèrent sur la page{' '}
          <Link href="/dashboard/ia" className="underline">Assistants IA</Link>.
        </p>
      </Card>
    </div>
  );
}
