// /dashboard/ia : relier un assistant IA (Claude, ChatGPT, Cursor…) à toutes les apps Veridian par la
// porte MCP du Hub, et voir ou couper les connexions actives. Adresse stable : Atlas y renvoie.
import { redirect } from 'next/navigation';

import { BotIcon } from 'lucide-react';

import { auth } from '@/auth';
import { Card } from '@/components/ui/card';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { abonnementOuvert, atelierConfigure, FOURNISSEUR_ABONNEMENT } from '@/lib/ia/atelier';
import { branchementsDe } from '@/lib/ia/branchements';
import { espacesDe } from '@/lib/mcp/catalogue';
import { connexionsActives } from '@/lib/mcp/connexions';
import { getEnabledGatedApps } from '@/lib/tenant-apps';
import { liensInstallation } from '@/lib/mcp/liens-installation';
import { prisma } from '@/lib/prisma';

import { ConnecterAssistant } from './ConnecterAssistant';
import { ConnexionsIa } from './ConnexionsIa';
import { MonAbonnement } from './MonAbonnement';
import { MonIa } from './MonIa';

export const dynamic = 'force-dynamic';

export default async function AssistantsIaPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?callbackUrl=/dashboard/ia');
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { supabaseUserId: true } });
  if (!user) redirect('/login');
  const connexions = user.supabaseUserId ? await connexionsActives(prisma, user.supabaseUserId) : [];
  const hubUserId = user.supabaseUserId;
  const [branchements, espaces, activations, ouvertes] = hubUserId
    ? await Promise.all([
        branchementsDe(prisma, hubUserId),
        espacesDe(prisma, hubUserId),
        prisma.iaActivation.findMany({ where: { hubUserId }, select: { app: true, tenantId: true, enabled: true } }),
        getEnabledGatedApps(prisma, hubUserId),
      ])
    : [[], [], [], new Set<string>()];
  // L'assistant n'est proposé que dans une app ouverte pour ce compte, et seulement pour les espaces
  // qui y existent : Academy pour tous ses espaces, le CRM pour ceux qui ont un workspace Twenty.
  const metas = espaces.length
    ? await prisma.tenant.findMany({ where: { id: { in: espaces.map((e) => e.id) } }, select: { id: true, metadata: true } })
    : [];
  const avecCrm = metas
    .filter((t) => typeof (t.metadata as { crm?: { workspace_id?: unknown } } | null)?.crm?.workspace_id === 'string')
    .map((t) => t.id);
  const espacesParApp: Record<string, string[]> = {};
  if (ouvertes.has('academy')) espacesParApp.academy = espaces.map((e) => e.id);
  if (ouvertes.has('twenty') && avecCrm.length) espacesParApp.crm = avecCrm;
  const apps = Object.keys(espacesParApp);
  // L'abonnement Claude : Robert seul tant qu'Anthropic n'a pas confirmé par écrit (docs/MON-IA.md).
  const abonnement = hubUserId && abonnementOuvert(hubUserId) && atelierConfigure();
  const abonnementBranche = branchements.some((b) => b.fournisseur === FOURNISSEUR_ABONNEMENT);

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <DashboardPageHeader
        title="Assistants IA"
        description="Une seule connexion donne à votre assistant l'accès à toutes vos apps Veridian, en votre nom."
        icon={BotIcon}
      />
      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-medium">Mon IA</h2>
        <p className="text-sm text-muted-foreground">
          Branchez votre propre IA une fois : elle devient l&apos;Assistant Veridian dans les apps où vous l&apos;allumez.
        </p>
        <MonIa
          branchements={branchements.filter((b) => b.fournisseur !== FOURNISSEUR_ABONNEMENT)}
          espaces={espaces.map((e) => ({ id: e.id, nom: e.nom }))}
          activations={activations}
          apps={apps}
          espacesParApp={espacesParApp}
        />
      </Card>
      {abonnement && (
        <Card className="p-6 space-y-4">
          <h2 className="text-lg font-medium">Mon abonnement Claude</h2>
          <MonAbonnement branche={abonnementBranche} />
        </Card>
      )}
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
