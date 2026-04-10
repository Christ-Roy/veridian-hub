'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Loader2, Trash2 } from 'lucide-react';
import type { WorkspaceRole } from '@/types/workspace';
import { WORKSPACE_ROLE_LABELS, canChangeRole, canRemoveMember } from '@/types/workspace';

const CHANGEABLE_ROLES: WorkspaceRole[] = ['ADMIN', 'MEMBER', 'VIEWER'];

interface MemberActionsProps {
  memberId: string;
  memberEmail: string;
  memberRole: WorkspaceRole;
  actorRole: WorkspaceRole;
  onUpdated?: () => void;
}

export function MemberActions({
  memberId,
  memberEmail,
  memberRole,
  actorRole,
  onUpdated,
}: MemberActionsProps) {
  const [loading, setLoading] = useState(false);

  async function handleRoleChange(newRole: WorkspaceRole) {
    if (newRole === memberRole) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/workspace/members/${memberId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Erreur lors du changement de rôle');
        return;
      }
      toast.success('Rôle mis à jour');
      onUpdated?.();
    } catch {
      toast.error('Erreur réseau');
    } finally {
      setLoading(false);
    }
  }

  async function handleRemove() {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspace/members/${memberId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? 'Erreur lors de la suppression');
        return;
      }
      toast.success(`${memberEmail} retiré du workspace`);
      onUpdated?.();
    } catch {
      toast.error('Erreur réseau');
    } finally {
      setLoading(false);
    }
  }

  const canChange = canChangeRole(actorRole, memberRole);
  const canRemove = canRemoveMember(actorRole, memberRole);

  if (!canChange && !canRemove) {
    return <span className="text-sm text-muted-foreground">{WORKSPACE_ROLE_LABELS[memberRole]}</span>;
  }

  return (
    <div className="flex items-center gap-2">
      {canChange ? (
        <Select
          value={memberRole}
          onValueChange={(v) => handleRoleChange(v as WorkspaceRole)}
          disabled={loading}
        >
          <SelectTrigger className="w-36 h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHANGEABLE_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {WORKSPACE_ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="text-sm text-muted-foreground">{WORKSPACE_ROLE_LABELS[memberRole]}</span>
      )}

      {canRemove && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Retirer ce membre ?</AlertDialogTitle>
              <AlertDialogDescription>
                <strong>{memberEmail}</strong> perdra accès au workspace immédiatement.
                Cette action ne peut pas être annulée.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annuler</AlertDialogCancel>
              <AlertDialogAction onClick={handleRemove} className="bg-destructive hover:bg-destructive/90">
                Retirer
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
