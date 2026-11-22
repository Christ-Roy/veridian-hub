// Fenêtre de l'Assistant Veridian (docs/MON-IA.md), affichée dans une app Veridian par une iframe.
// Seuls les hôtes des apps peuvent l'afficher (next.config.js, frame-ancestors) ; la clé et la session
// restent sur le Hub. Le fil vit dans l'app, relu par /api/ia/fil. Avant tout affichage, le serveur vérifie que
// l'espace est à l'utilisateur et, pour le CRM, que la page hôte est l'espace de ce workspace (menace 8).
import { headers } from 'next/headers';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { getCurrentUser } from '@/lib/auth/get-user';
import { estAppChat } from '@/lib/ia/branchements';
import { autoriserFenetre, MESSAGES_REFUS } from '@/lib/ia/fenetre';
import { prisma } from '@/lib/prisma';
import { ChatIa } from './ChatIa';

export const dynamic = 'force-dynamic';

export default async function ChatPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = await searchParams;
  // L'espace : le tenant Hub (Academy), ou le workspace de l'app (Twenty : le plugin ne connaît que le sien).
  if (!estAppChat(p.app) || (!p.tenant && !p.workspace)) return <p className="p-4 text-sm">Assistant indisponible : app ou espace manquant.</p>;
  const user = await getCurrentUser();
  if (!user?.supabaseUserId) {
    return (
      <p className="p-4 text-sm">
        Connectez-vous à votre espace Veridian pour utiliser l&apos;assistant.{' '}
        <a className="underline" href="/login" target="_top">
          Se connecter
        </a>
      </p>
    );
  }
  const f = await autoriserFenetre({
    app: p.app,
    tenant: p.tenant ?? null,
    workspace: p.workspace ?? null,
    referer: (await headers()).get('referer'),
    hubUserId: user.supabaseUserId,
  });
  if (!f.ok) {
    await writeAuditLog(prisma, { action: 'ia.refus', actor: user.email ?? 'inconnu', targetType: 'ia_chat', targetId: user.supabaseUserId, payload: { app: p.app, raison: f.refus } }).catch(() => {});
    return (
      <p className="p-4 text-sm" role="alert" data-refus={f.refus}>
        {MESSAGES_REFUS[f.refus]}
      </p>
    );
  }
  return <ChatIa app={p.app} tenantId={f.espace.id} workspaceId={f.espace.workspaceId} origine={f.origine} sessionId={p.session ?? null} />;
}
