// /dashboard/settings/security — toggle 2FA email opt-in.
// Server component : fetch l'état mfaEnabled du user courant via Prisma,
// délègue à un client component pour l'interaction.

import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { SecurityMfaToggle } from './SecurityMfaToggle';

export default async function SecuritySettingsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, mfaEnabled: true },
  });

  if (!user) {
    redirect('/login');
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Sécurité</h1>
        <p className="text-sm text-muted-foreground">
          Renforce la protection de ton compte Veridian.
        </p>
      </div>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-medium">Validation par email</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Quand tu te connectes depuis un nouvel appareil, Veridian t&apos;envoie un code
            à 6 chiffres par email. Ta session reste active pendant 3 mois pour éviter
            les reconnexions fréquentes.
          </p>
        </div>

        <SecurityMfaToggle initialEnabled={user.mfaEnabled} email={user.email} />
      </Card>
    </div>
  );
}
