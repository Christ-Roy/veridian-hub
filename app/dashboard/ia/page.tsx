// /dashboard/ia : relier un assistant IA (Claude, ChatGPT, Cursor…) à toutes les apps Veridian par la
// porte MCP du Hub, et voir ou couper les connexions actives. Adresse stable : Atlas y renvoie.
import { redirect } from 'next/navigation';

import { BotIcon } from 'lucide-react';

import { auth } from '@/auth';
import { Card } from '@/components/ui/card';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { connexionsActives } from '@/lib/mcp/connexions';
import { liensInstallation } from '@/lib/mcp/liens-installation';
import { prisma } from '@/lib/prisma';

import { ConnecterAssistant } from './ConnecterAssistant';
import { ConnexionsIa } from './ConnexionsIa';

export const dynamic = 'force-dynamic';

export default async function AssistantsIaPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/ia');
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { supabaseUserId: true } });
  if (!user) redirect('/login');
  const connexions = user.supabaseUserId ? await connexionsActives(prisma, user.supabaseUserId) : [];

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <DashboardPageHeader
        title="Assistants IA"
        description="Une seule connexion donne à votre assistant l'accès à toutes vos apps Veridian, en votre nom."
        icon={BotIcon}
      />
      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-medium">Connecter un assistant</h2>
        <ConnecterAssistant liens={liensInstallation()} />
      </Card>
      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-medium">Assistants connectés</h2>
        <ConnexionsIa connexions={connexions} />
      </Card>
    </div>
  );
}
