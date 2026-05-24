'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Form de renommage d'un workspace.
 *
 * Pattern aligne sur NameForm (settings profil) : Client Component avec
 * useState<isSubmitting>, disabled durant submit, label dynamique, toast
 * success/error, `router.refresh()` au succès pour rafraîchir le nom
 * dans la sidebar + page header (qui sont des Server Components).
 *
 * Sécurité côté route : PATCH `/api/workspace/:id/rename` vérifie que
 * `user.id === workspace.ownerId` (403 sinon). Le form est donc safe
 * même si exposé à des members non-owner — la route refusera côté serveur.
 */
export function WorkspaceRenameForm({
  workspaceId,
  currentName,
  canRename,
}: {
  workspaceId: string;
  currentName: string;
  canRename: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(currentName);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentName || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/rename`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error('Renommage échoué', {
          description: mapErrorCode(data.error) ?? `HTTP ${res.status}`,
          duration: 5000,
        });
        return;
      }

      toast.success('Workspace renommé.', {
        description: `Nouveau nom : ${data.name}`,
      });
      router.refresh();
    } catch (err) {
      toast.error('Erreur réseau', {
        description: err instanceof Error ? err.message : 'Réessaie.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const disabled =
    !canRename || isSubmitting || !name.trim() || name.trim() === currentName;

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="workspace-name">Nom du workspace</Label>
        <Input
          id="workspace-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          disabled={!canRename || isSubmitting}
          aria-describedby="workspace-name-help"
        />
        <p id="workspace-name-help" className="text-xs text-muted-foreground">
          80 caractères maximum.{' '}
          {!canRename && (
            <span className="text-destructive">
              Seul le propriétaire peut renommer ce workspace.
            </span>
          )}
        </p>
      </div>
      <Button type="submit" disabled={disabled}>
        {isSubmitting ? 'Mise à jour…' : 'Renommer'}
      </Button>
    </form>
  );
}

function mapErrorCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  switch (code) {
    case 'forbidden_not_owner':
      return 'Seul le propriétaire peut renommer ce workspace.';
    case 'workspace_not_found':
      return 'Workspace introuvable.';
    case 'invalid_payload':
      return 'Nom invalide (1 à 80 caractères).';
    default:
      return null;
  }
}
