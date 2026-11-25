import { IMPERSONATION_SESSION_TTL_S } from '@/lib/auth/emprunt-bornes';

import { SortirAvantLaFin } from './SortirAvantLaFin';

/** On est chez un client (VER-263) : chez qui, jusqu'à quand, et la sortie. Toujours visible, sur téléphone aussi. */
export function BandeauEmprunt({ email, debutS }: { email: string; debutS?: number }) {
  const finMs = ((debutS ?? 0) + IMPERSONATION_SESSION_TTL_S) * 1000;
  const heure = new Date(finMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  return (
    <div role="status" data-testid="bandeau-emprunt" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-destructive bg-destructive px-4 py-2 text-sm text-destructive-foreground">
      <p className="min-w-0 flex-1">
        Vous êtes chez <strong className="break-all">{email}</strong> jusqu&apos;à {heure}. Au Hub, rien ne se modifie.
      </p>
      <form method="post" action="/api/auth/emprunt/sortir">
        <button type="submit" className="rounded-md bg-background px-3 py-1.5 font-medium text-foreground hover:opacity-90">
          Sortir
        </button>
      </form>
      <SortirAvantLaFin finMs={finMs} />
    </div>
  );
}
