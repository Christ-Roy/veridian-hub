// /dashboard/ia : relier un assistant IA (Claude, ChatGPT, Cursor…) à toutes les apps Veridian par la
// porte MCP du Hub, et voir ou couper les connexions actives. Adresse stable : Atlas y renvoie.
import { redirect } from 'next/navigation';

import { BotIcon } from 'lucide-react';

import { auth } from '@/auth';
import { Card } from '@/components/ui/card';
import { DashboardPageHeader } from '@/components/dashboard/PageHeader';
import { atelierConfigure, FOURNISSEUR_ABONNEMENT, tenantOuvertDuCompte } from '@/lib/ia/atelier';
import { branchementsDe } from '@/lib/ia/branchements';
import { appsDe, espacesDe } from '@/lib/mcp/catalogue';
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
  const [branchements, espaces, activations, ouvertes, appsPorte] = hubUserId
    ? await Promise.all([
        branchementsDe(prisma, hubUserId),
        espacesDe(prisma, hubUserId),
        prisma.iaActivation.findMany({ where: { hubUserId }, select: { app: true, tenantId: true, enabled: true } }),
        getEnabledGatedApps(prisma, hubUserId),
        appsDe(prisma, hubUserId),
      ])
    : [[], [], [], new Set<string>(), []];
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
  // L'abonnement Claude : ouvert par tenant (hub ia atelier ouvrir), fermé par défaut (docs/MON-IA.md).
  // Carte affichée seulement si l'atelier de cet espace tourne (un atelier par tenant, décision A).
  const tenantAbonnement = hubUserId ? await tenantOuvertDuCompte(prisma as never, hubUserId) : null;
  const abonnement = atelierConfigure(tenantAbonnement);
  const abonnementBranche = branchements.some((b) => b.fournisseur === FOURNISSEUR_ABONNEMENT);
  const cles = branchements.filter((b) => b.fournisseur !== FOURNISSEUR_ABONNEMENT);
  const espacesVus = espaces.map((e) => ({ id: e.id, nom: e.nom }));

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <DashboardPageHeader
        title="Assistants IA"
        description="Une seule connexion donne à votre assistant l'accès à toutes vos apps Veridian, en votre nom."
        icon={BotIcon}
      />
      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-medium">Connecter votre IA</h2>
        <p className="text-sm text-muted-foreground">
          Un seul branchement, sans clé : connectez-vous, autorisez, et votre IA travaille dans toutes vos apps. Rien d&apos;autre à régler.
        </p>
        {appsPorte.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Apps ouvertes à votre IA">
            {appsPorte.map((a) => (
              <li key={a.appKey} className="rounded-md border border-border px-2 py-1 text-xs">
                {a.label}
              </li>
            ))}
          </ul>
        )}
        <ConnecterAssistant liens={liensInstallation()} />
      </Card>
      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-medium">Assistants connectés</h2>
        <ConnexionsIa connexions={connexions} />
      </Card>
      {abonnement && (
        <Card className="p-6 space-y-4">
          <h2 className="text-lg font-medium">Mon abonnement Claude</h2>
          <MonAbonnement branche={abonnementBranche} />
        </Card>
      )}
      {/* L'assistant DANS l'app (CRM, Academy) ne passe pas par le connecteur : lui seul peut avoir besoin d'une clé. */}
      {apps.length > 0 && (cles.length > 0 || abonnementBranche) ? (
        <Card className="p-6 space-y-4">
          <h2 className="text-lg font-medium">L&apos;assistant intégré à vos apps</h2>
          <MonIa branchements={cles} espaces={espacesVus} activations={activations} apps={apps} espacesParApp={espacesParApp} />
        </Card>
      ) : espacesParApp.crm || cles.length > 0 ? (
        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm text-muted-foreground">Avancé : l&apos;assistant intégré au CRM</summary>
          <div className="space-y-4 pt-4">
            <p className="text-sm text-muted-foreground">
              Facultatif. Votre IA connectée travaille déjà dans le CRM ; ceci ne sert qu&apos;à la fenêtre de discussion du CRM lui-même.
            </p>
            <MonIa branchements={cles} espaces={espacesVus} activations={activations} apps={apps} espacesParApp={espacesParApp} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
