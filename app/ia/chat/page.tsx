// Fenêtre de l'Assistant Veridian (docs/MON-IA.md), affichée dans une app Veridian par une iframe.
// Seuls les hôtes des apps peuvent l'afficher (next.config.js, frame-ancestors) ; la clé et la session
// restent sur le Hub. Le fil vit dans l'app, relu par /api/ia/fil.
import { auth } from '@/auth';
import { estAppChat } from '@/lib/ia/branchements';
import { ChatIa } from './ChatIa';

export const dynamic = 'force-dynamic';

export default async function ChatPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = await searchParams;
  const session = await auth();
  if (!estAppChat(p.app) || !p.tenant) return <p className="p-4 text-sm">Assistant indisponible : app ou espace manquant.</p>;
  if (!session?.user?.id) {
    return (
      <p className="p-4 text-sm">
        Connectez-vous à votre espace Veridian pour utiliser l&apos;assistant.{' '}
        <a className="underline" href="/login" target="_top">
          Se connecter
        </a>
      </p>
    );
  }
  return <ChatIa app={p.app} tenantId={p.tenant} sessionId={p.session ?? null} />;
}
